package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	nats "github.com/nats-io/nats.go"
)

// ── First-run setup token (#12) ───────────────────────────────────────────────
// A fresh install has no administrator. The installer prints a link carrying a
// one-time token; the setup assistant needs it to create the administrator,
// then the token is deleted. Only root can read it, and the backend never does:
// it asks the worker to compare.

func setupTokenPath() string { return envOr("HSI_SETUP_TOKEN", "/etc/hsi/setup-token") }

func writeSetupToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	tok := base64.RawURLEncoding.EncodeToString(b)
	p := setupTokenPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return "", err
	}
	if err := writeFileAtomic(p, []byte(tok+"\n"), 0o600); err != nil {
		return "", err
	}
	// writeFileAtomic keeps the mode of an existing file: set it explicitly.
	return tok, os.Chmod(p, 0o600)
}

func verifySetupToken(given string) bool {
	raw, err := os.ReadFile(setupTokenPath())
	if err != nil {
		return false
	}
	want := strings.TrimSpace(string(raw))
	given = strings.TrimSpace(given)
	if want == "" || given == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(want), []byte(given)) == 1
}

func consumeSetupToken() error {
	if err := os.Remove(setupTokenPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func setupLink(ip string, port int, token string) string {
	host := ip
	if port != 80 {
		host += ":" + strconv.Itoa(port)
	}
	// In the fragment: browsers never send it, so no request log holds it.
	return "http://" + host + "/setup#token=" + token
}

// firstIPv4 is the address printed in the link when the installer does not
// pass one: the first IPv4 that is neither loopback nor link-local.
func firstIPv4() string {
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && !n.IP.IsLoopback() && !n.IP.IsLinkLocalUnicast() {
			return n.IP.String()
		}
	}
	return "<server>"
}

// runSetupTokenCLI is `hsi-worker setup-token [--host ADDR] [--port N]`.
func runSetupTokenCLI(args []string) int {
	port := 9001
	host := ""
	for i := 0; i < len(args); i++ {
		if args[i] == "--host" && i+1 < len(args) {
			host = args[i+1]
			i++
			continue
		}
		if args[i] == "--port" && i+1 < len(args) {
			p, err := strconv.Atoi(args[i+1])
			if err != nil || p < 1 || p > 65535 {
				fmt.Fprintln(os.Stderr, "invalid port")
				return 2
			}
			port = p
			i++
		}
	}
	tok, err := writeSetupToken()
	if err != nil {
		fmt.Fprintln(os.Stderr, "could not write the setup token:", err)
		return 1
	}
	if host == "" {
		host = firstIPv4()
	}
	fmt.Println(setupLink(host, port, tok))
	return 0
}

func handleSetupVerify(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(msg.Data, &req)
	replyOk(nc, msg.Reply, map[string]any{"ok": verifySetupToken(req.Token)})
}

func handleSetupConsume(nc *nats.Conn, msg *nats.Msg) {
	if err := consumeSetupToken(); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	replyOk(nc, msg.Reply, map[string]any{})
}
