package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	nats "github.com/nats-io/nats.go"
)

// ── Plan builder: server identity (#12) ──────────────────────────────────────
// The hostname and time zone, set from the first-run setup assistant (and
// later from Settings). The 127.0.1.1 line of /etc/hosts follows the hostname,
// so sudo and Samba keep resolving the machine's own name.

var (
	hostsPath    = "/etc/hosts"
	hostHostname = func() string {
		o, _ := hostOutput("hostnamectl", "--static")
		return strings.TrimSpace(string(o))
	}
	hostTimezone = func() string {
		o, _ := hostOutput("timedatectl", "show", "-p", "Timezone", "--value")
		return strings.TrimSpace(string(o))
	}
	hostTimezones = func() []string {
		o, _ := hostOutput("timedatectl", "list-timezones")
		return strings.Fields(string(o))
	}
)

var reHostname = regexp.MustCompile(`^(?i)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// hostsWithName names `name` on the 127.0.1.1 line, adding one after the
// 127.0.0.1 line when there is none. The old name is renamed in place, so a
// domain (old.example.lan) and other aliases are kept; a line naming another
// host is replaced. Other lines are kept as they are.
func hostsWithName(conf, old, name string) string {
	lines := splitConf(conf)
	for i, l := range lines {
		f := strings.Fields(l)
		if len(f) < 1 || f[0] != "127.0.1.1" {
			continue
		}
		renamed := false
		for j := 1; j < len(f); j++ {
			switch {
			case old != "" && f[j] == old:
				f[j], renamed = name, true
			case old != "" && strings.HasPrefix(f[j], old+"."):
				f[j], renamed = name+strings.TrimPrefix(f[j], old), true
			}
		}
		if renamed {
			lines[i] = "127.0.1.1\t" + strings.Join(f[1:], " ")
		} else {
			lines[i] = "127.0.1.1\t" + name
		}
		return joinConf(lines)
	}
	out := make([]string, 0, len(lines)+1)
	added := false
	for _, l := range lines {
		out = append(out, l)
		if f := strings.Fields(l); !added && len(f) >= 1 && f[0] == "127.0.0.1" {
			out = append(out, "127.0.1.1\t"+name)
			added = true
		}
	}
	if !added {
		out = append(out, "127.0.1.1\t"+name)
	}
	return joinConf(out)
}

func planSystemIdentity(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Hostname string `json:"hostname"`
		Timezone string `json:"timezone"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	curHost, curZone := hostHostname(), hostTimezone()
	obs := map[string]string{"hostname": curHost, "timezone": curZone}
	var steps []planStep

	if req.Hostname != "" && req.Hostname != curHost {
		if !reHostname.MatchString(req.Hostname) {
			return nil, &fsError{Code: "ERR", Message: "A hostname uses letters, digits and hyphens (up to 63), and does not start or end with a hyphen"}
		}
		name := req.Hostname
		steps = append(steps, cmdStep(name, "Name this server "+name, []string{"hostnamectl", "set-hostname", name}))
		before, _ := hostReadFile(hostsPath)
		obs["hosts"] = string(before)
		after := hostsWithName(string(before), curHost, name)
		steps = append(steps, planStep{Kind: "update", Target: hostsPath, Summary: "Resolve " + name + " on this server", OnFailure: "warn",
			Diff: unifiedDiff(hostsPath, string(before), after),
			run: func() (string, error) {
				cur, err := hostReadFile(hostsPath)
				if err != nil {
					return "", err
				}
				return "", writeFileAtomic(hostsPath, []byte(hostsWithName(string(cur), curHost, name)), 0o644)
			}})
	}
	if req.Timezone != "" && req.Timezone != curZone {
		if !containsString(hostTimezones(), req.Timezone) {
			return nil, &fsError{Code: "ERR", Message: fmt.Sprintf("Unknown time zone %q", req.Timezone)}
		}
		steps = append(steps, cmdStep(req.Timezone, "Set the time zone to "+req.Timezone, []string{"timedatectl", "set-timezone", req.Timezone}))
	}
	if len(steps) == 0 {
		return nil, &fsError{Code: "ENOOP", Message: "The hostname and time zone are already set"}
	}
	return &opPlan{Op: "system.identity", Steps: steps, Observed: obs}, nil
}

type identityStatus struct {
	Hostname  string   `json:"hostname"`
	Timezone  string   `json:"timezone"`
	Timezones []string `json:"timezones"`
}

func systemIdentity() identityStatus {
	return identityStatus{Hostname: hostHostname(), Timezone: hostTimezone(), Timezones: hostTimezones()}
}

func handleSystemIdentity(nc *nats.Conn, msg *nats.Msg) {
	replyOk(nc, msg.Reply, systemIdentity())
}
