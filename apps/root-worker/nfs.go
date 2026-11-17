package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/nats-io/nats.go"
)

// ── NFS exports ──────────────────────────────────────────────────────────────
// HSI owns /etc/exports.d/hsi.exports and never touches /etc/exports. NFS has
// no sign-in: an export trusts the listed client addresses, and every client
// user is mapped to one account (all_squash) so file ownership stays HSI's.

const nfsExportsPath = "/etc/exports.d/hsi.exports"

// maxNfsClients bounds an export's client list.
const maxNfsClients = 16

type nfsExportDef struct {
	Path    string   `json:"path"`
	Clients []string `json:"clients"`
	// WriteAs: the Linux account new files belong to; empty exports read-only.
	WriteAs string `json:"writeAs"`
	// Fsid: the share's id, so a client keeps its handles across restarts.
	Fsid        string `json:"fsid"`
	Unavailable bool   `json:"unavailable"`
}

// nfsIDs resolves the ids an export maps its clients to.
type nfsIDs struct {
	uid      func(name string) (int, error)
	shareGID int
}

func hostNfsIDs() (nfsIDs, error) {
	g, err := user.LookupGroup(shareGroup)
	if err != nil {
		return nfsIDs{}, fmt.Errorf("group %s is missing: %w", shareGroup, err)
	}
	gid, err := strconv.Atoi(g.Gid)
	if err != nil {
		return nfsIDs{}, err
	}
	return nfsIDs{shareGID: gid, uid: func(name string) (int, error) {
		u, err := user.Lookup(name)
		if err != nil {
			return 0, err
		}
		return strconv.Atoi(u.Uid)
	}}, nil
}

var reFsid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// nfsClient validates one client entry: an address or a network, never the
// whole internet and never a name (which could carry export options).
func nfsClient(c string) (string, error) {
	if ip := net.ParseIP(c); ip != nil {
		return ip.String(), nil
	}
	_, n, err := net.ParseCIDR(c)
	if err != nil {
		return "", fmt.Errorf("invalid NFS client %q: an address or a network like 192.168.1.0/24", c)
	}
	if ones, _ := n.Mask.Size(); ones == 0 {
		return "", fmt.Errorf("refusing to export to every address (%s)", c)
	}
	return n.String(), nil
}

func validNfsPath(p string) bool {
	return filepath.IsAbs(p) && filepath.Clean(p) == p &&
		!strings.ContainsFunc(p, func(r rune) bool { return r == '"' || r == '\\' || r < 0x20 || r == 0x7f })
}

// renderExports returns the exports file, or "" when nothing is exported.
func renderExports(exports []nfsExportDef, ids nfsIDs) (string, error) {
	sorted := append([]nfsExportDef(nil), exports...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Path < sorted[j].Path })
	var b strings.Builder
	for _, e := range sorted {
		if !validNfsPath(e.Path) {
			return "", fmt.Errorf("invalid NFS path %q", e.Path)
		}
		if !reFsid.MatchString(e.Fsid) {
			return "", fmt.Errorf("invalid NFS fsid %q", e.Fsid)
		}
		if len(e.Clients) == 0 || len(e.Clients) > maxNfsClients {
			return "", fmt.Errorf("%s: between 1 and %d NFS clients", e.Path, maxNfsClients)
		}
		clients := make([]string, 0, len(e.Clients))
		for _, c := range e.Clients {
			n, err := nfsClient(c)
			if err != nil {
				return "", err
			}
			clients = append(clients, n)
		}
		mode, owner := "ro", "nobody"
		if e.WriteAs != "" {
			if e.WriteAs == "root" || !reLinuxUsername.MatchString(e.WriteAs) {
				return "", fmt.Errorf("invalid NFS owner %q", e.WriteAs)
			}
			mode, owner = "rw", e.WriteAs
		}
		uid, err := ids.uid(owner)
		if err != nil && owner != "nobody" {
			// The account is gone: the export stays, read-only.
			log.Printf("nfs: %q has no account here; %s exported read-only", owner, e.Path)
			mode, owner = "ro", "nobody"
			uid, err = ids.uid(owner)
		}
		if err != nil {
			return "", fmt.Errorf("NFS account %q is missing", owner)
		}
		if e.Unavailable {
			continue
		}
		opts := fmt.Sprintf("(%s,sync,no_subtree_check,insecure,all_squash,anonuid=%d,anongid=%d,fsid=%s)", mode, uid, ids.shareGID, e.Fsid)
		b.WriteString(`"` + e.Path + `"`)
		for _, c := range clients {
			b.WriteString(" " + c + opts)
		}
		b.WriteString("\n")
	}
	if b.Len() == 0 {
		return "", nil
	}
	return "# Managed by HSI root-worker. Do not edit; regenerated on every sync.\n" + b.String(), nil
}

// nfsdClientsDir lists the NFSv4.1+ clients the kernel server knows.
const nfsdClientsDir = "/proc/fs/nfsd/clients"

// nfsClientAddress is the client's address in an nfsd clients/N/info file.
func nfsClientAddress(info string) string {
	for _, l := range strings.Split(info, "\n") {
		v, ok := strings.CutPrefix(strings.TrimSpace(l), "address:")
		if !ok {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"`)
		if host, _, err := net.SplitHostPort(v); err == nil {
			v = host
		}
		if ip := net.ParseIP(v); ip != nil {
			return ip.String()
		}
	}
	return ""
}

// nfsClients are the machines with the NFS server's folders mounted now,
// each once; empty without nfsd or for NFSv3 clients, which it does not list.
func nfsClients(dir string) []string {
	entries, _ := os.ReadDir(dir)
	seen := map[string]bool{}
	out := []string{}
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(dir, e.Name(), "info"))
		if err != nil {
			continue
		}
		if ip := nfsClientAddress(string(b)); ip != "" && !seen[ip] {
			seen[ip] = true
			out = append(out, ip)
		}
	}
	sort.Strings(out)
	return out
}

func handleSharingNfs(nc *nats.Conn, msg *nats.Msg) {
	installed := hostLookPath("exportfs")
	res := map[string]any{"installed": installed, "active": false, "clients": []string{}}
	if installed {
		res["active"] = smbRun("systemctl", "is-active", "--quiet", "nfs-server") == nil
		res["clients"] = nfsClients(nfsdClientsDir)
	}
	replyOk(nc, msg.Reply, res)
}
