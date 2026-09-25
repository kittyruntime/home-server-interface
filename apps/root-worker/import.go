package main

import (
	"encoding/json"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	nats "github.com/nats-io/nats.go"
)

// Importing existing storage (after reinstalling, or with disks from another
// machine). Nothing here writes to a disk's data: arrays are assembled from
// their own superblocks and volume groups are activated. Filesystems found on
// the result are mounted through the normal mount flow.

// foundArray is an md array described by the superblocks on the disks.
type foundArray struct {
	Device   string   `json:"device"` // /dev/md/0 as recorded on disk
	Level    string   `json:"level"`
	UUID     string   `json:"uuid"`
	Name     string   `json:"name"`     // host:name recorded on disk
	Expected int      `json:"expected"` // num-devices
	Members  []string `json:"members"`  // devices found here
	Missing  int      `json:"missing"`  // Expected - len(Members)
}

// foundVG is a volume group whose logical volumes are all inactive.
type foundVG struct {
	Name string   `json:"name"`
	LVs  []string `json:"lvs"`
}

var reKV = regexp.MustCompile(`(\S+)=(\S+)`)

// parseExamineScan parses `mdadm --examine --scan --verbose`.
func parseExamineScan(out string) []foundArray {
	var arrays []foundArray
	for _, line := range strings.Split(out, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trimmed, "ARRAY "):
			f := strings.Fields(trimmed)
			a := foundArray{Device: f[1]}
			for _, m := range reKV.FindAllStringSubmatch(trimmed, -1) {
				switch m[1] {
				case "level":
					a.Level = m[2]
				case "UUID":
					a.UUID = m[2]
				case "name":
					a.Name = m[2]
				case "num-devices":
					a.Expected, _ = strconv.Atoi(m[2])
				}
			}
			arrays = append(arrays, a)
		case strings.HasPrefix(trimmed, "devices=") && len(arrays) > 0:
			arrays[len(arrays)-1].Members = strings.Split(strings.TrimPrefix(trimmed, "devices="), ",")
		}
	}
	return arrays
}

// unassembledArrays keeps the arrays that are not running, and counts the
// members that were not found on this machine.
func unassembledArrays(found []foundArray, active map[string]bool) []foundArray {
	out := []foundArray{}
	for _, a := range found {
		if active[a.UUID] {
			continue
		}
		if a.Expected > len(a.Members) {
			a.Missing = a.Expected - len(a.Members)
		}
		out = append(out, a)
	}
	return out
}

// parseInactiveVGs parses `lvs --noheadings --separator : -o vg_name,lv_name,lv_active`
// and returns volume groups where no logical volume is active.
func parseInactiveVGs(out string) []foundVG {
	order := []string{}
	lvs := map[string][]string{}
	anyActive := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(strings.TrimSpace(line), ":")
		if len(f) < 3 || f[0] == "" {
			continue
		}
		vg := f[0]
		if _, seen := lvs[vg]; !seen {
			order = append(order, vg)
		}
		lvs[vg] = append(lvs[vg], f[1])
		if strings.TrimSpace(f[2]) != "" {
			anyActive[vg] = true
		}
	}
	out2 := []foundVG{}
	for _, vg := range order {
		if !anyActive[vg] {
			out2 = append(out2, foundVG{Name: vg, LVs: lvs[vg]})
		}
	}
	return out2
}

func activeArrayUUIDs() map[string]bool {
	active := map[string]bool{}
	out, err := exec.Command("mdadm", "--detail", "--scan").Output()
	if err != nil {
		return active
	}
	for _, line := range strings.Split(string(out), "\n") {
		if _, uuid := arrayLineFields(line); uuid != "" {
			active[uuid] = true
		}
	}
	return active
}

func handleImportScan(nc *nats.Conn, msg *nats.Msg) {
	arrays := []foundArray{}
	if _, err := exec.LookPath("mdadm"); err == nil {
		// --examine only reads superblocks; nothing is assembled here.
		if out, err := exec.Command("mdadm", "--examine", "--scan", "--verbose").Output(); err == nil {
			arrays = unassembledArrays(parseExamineScan(string(out)), activeArrayUUIDs())
		}
	}
	vgs := []foundVG{}
	if _, err := exec.LookPath("lvs"); err == nil {
		if out, err := exec.Command("lvs", "--noheadings", "--separator", ":", "-o", "vg_name,lv_name,lv_active").Output(); err == nil {
			vgs = parseInactiveVGs(string(out))
		}
	}
	replyOk(nc, msg.Reply, map[string]any{"arrays": arrays, "vgs": vgs})
}

var reUUID = regexp.MustCompile(`^[0-9a-fA-F:]{8,64}$`)

// handleImportAssemble assembles one found array by UUID under /dev/<name>.
// A degraded array (members missing) is only started when allowDegraded is
// set: mdadm refuses by default, and forcing it silently could hide a disk
// that is simply not plugged in.
func handleImportAssemble(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		UUID          string `json:"uuid"`
		Name          string `json:"name"` // md device to create, e.g. md1
		AllowDegraded bool   `json:"allowDegraded"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil || !reUUID.MatchString(req.UUID) || !reMdDev.MatchString(req.Name) {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid request"})
		return
	}
	if activeArrayUUIDs()[req.UUID] {
		replyErr(nc, msg.Reply, &fsError{Code: "EEXIST", Message: "this array is already running"})
		return
	}
	args := []string{"--assemble", "/dev/" + req.Name, "--uuid=" + req.UUID, "--scan"}
	if req.AllowDegraded {
		args = append(args, "--run")
	}
	out, err := exec.Command("mdadm", args...).CombinedOutput()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: cmdErrMessage(out, err)})
		return
	}
	var warnings []string
	briefOut, berr := exec.Command("mdadm", "--detail", "--brief", "/dev/"+req.Name).CombinedOutput()
	if line := briefArrayLine(string(briefOut)); line != "" {
		warnings = updateMdadmConf(func(conf string) string { return upsertArrayLine(conf, req.Name, line) })
	} else {
		warnings = append(warnings, "could not read the array definition: "+cmdErrMessage(briefOut, berr))
	}
	logger.Info("raid imported", "array", req.Name, "uuid", req.UUID, "degraded", req.AllowDegraded)
	replyOk(nc, msg.Reply, map[string]any{"ok": true, "device": "/dev/" + req.Name, "warnings": warnings})
}

// Volume groups made elsewhere may use any name LVM allows (dots, plus signs),
// unlike the stricter names HSI gives the groups it creates (reVGName).
var reImportVGName = regexp.MustCompile(`^[a-zA-Z0-9+_.][a-zA-Z0-9+_.-]{0,126}$`)

// handleImportActivateVG activates the logical volumes of a found volume group.
func handleImportActivateVG(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil || !reImportVGName.MatchString(req.Name) {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid volume group name"})
		return
	}
	out, err := exec.Command("vgchange", "-ay", req.Name).CombinedOutput()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: cmdErrMessage(out, err)})
		return
	}
	logger.Info("volume group activated", "vg", req.Name)
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}
