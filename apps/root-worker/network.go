package main

import (
	"encoding/json"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"

	nats "github.com/nats-io/nats.go"
)

// ── Network settings (#11) ───────────────────────────────────────────────────
// IPv4 addressing and DNS of an interface, through NetworkManager. A change is
// applied under a NetworkManager checkpoint: NetworkManager itself restores the
// previous settings when the change is not confirmed in time, so a mistake that
// cuts the dashboard off undoes itself even if HSI's backend is not running.
// Inside a container the host owns the network, and nothing is changed.

const (
	nmBus  = "org.freedesktop.NetworkManager"
	nmPath = "/org/freedesktop/NetworkManager"
	// How long a change waits for its confirmation before NetworkManager
	// puts the previous settings back.
	networkConfirmSeconds = 120
)

var (
	reCheckpoint = regexp.MustCompile(`^/org/freedesktop/NetworkManager/Checkpoint/[0-9]+$`)
	reNMDevice   = regexp.MustCompile(`^[A-Za-z0-9._-]{1,15}$`)
	reNMUUID     = regexp.MustCompile(`^[0-9a-fA-F-]{36}$`)

	// The container technology HSI runs in ("" on a machine or a VM).
	hostContainer = func() string {
		o, _ := hostOutput("systemd-detect-virt", "--container")
		v := strings.TrimSpace(string(o))
		if v == "none" {
			return ""
		}
		return v
	}
	nmRunning = func() bool {
		o, err := hostOutput("nmcli", "-t", "-f", "RUNNING", "general")
		return err == nil && strings.TrimSpace(string(o)) == "running"
	}
)

type networkInterface struct {
	Device     string   `json:"device"`
	Type       string   `json:"type"`
	State      string   `json:"state"`
	Managed    bool     `json:"managed"` // NetworkManager manages it with a connection HSI can edit
	Connection string   `json:"connection,omitempty"`
	UUID       string   `json:"uuid,omitempty"`
	Method     string   `json:"method,omitempty"` // auto (DHCP) or manual
	Addresses  []string `json:"addresses"`        // current, CIDR
	Gateway    string   `json:"gateway,omitempty"`
	DNS        []string `json:"dns"`
	// What the connection is set to (manual addressing, DNS servers set by hand).
	ConfiguredAddresses []string `json:"configuredAddresses"`
	ConfiguredGateway   string   `json:"configuredGateway,omitempty"`
	ConfiguredDNS       []string `json:"configuredDns"`
}

type networkStatus struct {
	// Why HSI cannot change the network here, if it cannot.
	Unavailable string             `json:"unavailable,omitempty"`
	Container   string             `json:"container,omitempty"`
	Interfaces  []networkInterface `json:"interfaces"`
	ConfirmSecs int                `json:"confirmSeconds"`
	// Changes waiting for their confirmation (NetworkManager checkpoints): a
	// page opened at the new address offers to keep or undo them.
	Pending []string `json:"pending"`
}

// busctl get-property output for an array of object paths:
// `ao 2 "/org/.../Checkpoint/3" "/org/.../Checkpoint/4"`.
func parseCheckpoints(out string) []string {
	paths := []string{}
	f := strings.Fields(strings.TrimSpace(out))
	if len(f) < 2 || f[0] != "ao" {
		return paths
	}
	for _, p := range f[2:] {
		if p = strings.Trim(p, `"`); reCheckpoint.MatchString(p) {
			paths = append(paths, p)
		}
	}
	return paths
}

var nmCheckpoints = func() []string {
	o, err := hostOutput("busctl", "get-property", nmBus, nmPath, nmBus, "Checkpoints")
	if err != nil {
		return []string{}
	}
	return parseCheckpoints(string(o))
}

// nmcliFields reads `nmcli -t` output of the `field:value` form. Repeated
// fields (IP4.ADDRESS[1], [2]…) are gathered under their name without index.
func nmcliFields(out string) map[string][]string {
	fields := map[string][]string{}
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		if i := strings.IndexByte(k, '['); i > 0 {
			k = k[:i]
		}
		v = strings.ReplaceAll(v, `\:`, ":")
		fields[k] = append(fields[k], v)
	}
	return fields
}

func first(m map[string][]string, k string) string {
	if v := m[k]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// splitList reads a list nmcli prints joined by commas ("1.1.1.1,9.9.9.9").
func splitList(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" && p != "--" {
			out = append(out, p)
		}
	}
	return out
}

func readNetworkStatus() networkStatus {
	st := networkStatus{Interfaces: []networkInterface{}, ConfirmSecs: networkConfirmSeconds, Pending: []string{}}
	if c := hostContainer(); c != "" {
		st.Container = c
		st.Unavailable = "HSI runs in a container (" + c + "): its network is set on the container host."
		return st
	}
	if !nmRunning() {
		st.Unavailable = "NetworkManager is not running on this server: HSI changes the network through it."
		return st
	}
	st.Pending = nmCheckpoints()
	o, err := hostOutput("nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CON-UUID", "device", "status")
	if err != nil {
		st.Unavailable = "NetworkManager did not list the network interfaces."
		return st
	}
	for _, line := range strings.Split(strings.TrimSpace(string(o)), "\n") {
		f := strings.Split(line, ":")
		if len(f) < 4 || (f[1] != "ethernet" && f[1] != "wifi" && f[1] != "bond" && f[1] != "bridge" && f[1] != "vlan") {
			continue
		}
		iface := networkInterface{Device: f[0], Type: f[1], State: f[2], UUID: f[3], Addresses: []string{}, DNS: []string{}, ConfiguredAddresses: []string{}, ConfiguredDNS: []string{}}
		if dev, err := hostOutput("nmcli", "-t", "-f", "IP4.ADDRESS,IP4.GATEWAY,IP4.DNS", "device", "show", iface.Device); err == nil {
			m := nmcliFields(string(dev))
			iface.Addresses = append(iface.Addresses, m["IP4.ADDRESS"]...)
			if g := first(m, "IP4.GATEWAY"); g != "--" {
				iface.Gateway = g
			}
			iface.DNS = append(iface.DNS, m["IP4.DNS"]...)
		}
		if reNMUUID.MatchString(iface.UUID) {
			if con, err := hostOutput("nmcli", "-t", "-f", "connection.id,ipv4.method,ipv4.addresses,ipv4.gateway,ipv4.dns", "connection", "show", iface.UUID); err == nil {
				m := nmcliFields(string(con))
				iface.Connection = first(m, "connection.id")
				iface.Method = first(m, "ipv4.method")
				iface.ConfiguredAddresses = splitList(first(m, "ipv4.addresses"))
				if g := first(m, "ipv4.gateway"); g != "--" {
					iface.ConfiguredGateway = g
				}
				iface.ConfiguredDNS = splitList(first(m, "ipv4.dns"))
				iface.Managed = iface.Method == "auto" || iface.Method == "manual"
			}
		} else {
			iface.UUID = ""
		}
		st.Interfaces = append(st.Interfaces, iface)
	}
	return st
}

func handleNetworkStatus(nc *nats.Conn, msg *nats.Msg) {
	replyOk(nc, msg.Reply, readNetworkStatus())
}

type ipv4Request struct {
	Device  string   `json:"device"`
	Method  string   `json:"method"`  // auto or manual
	Address string   `json:"address"` // CIDR, manual only
	Gateway string   `json:"gateway"` // manual only, optional
	DNS     []string `json:"dns"`     // empty: from DHCP (auto) or none (manual)
}

func validIPv4(s string) bool {
	ip := net.ParseIP(s)
	return ip != nil && ip.To4() != nil
}

// validate checks the request and returns the nmcli settings it sets.
func (r ipv4Request) settings() ([]string, error) {
	if len(r.DNS) > 3 {
		return nil, fmt.Errorf("Up to 3 DNS servers")
	}
	for _, d := range r.DNS {
		if !validIPv4(d) {
			return nil, fmt.Errorf("%q is not an IPv4 address", d)
		}
	}
	dns := strings.Join(r.DNS, ",")
	switch r.Method {
	case "auto":
		ignore := "no"
		if len(r.DNS) > 0 {
			ignore = "yes"
		}
		return []string{"ipv4.method", "auto", "ipv4.addresses", "", "ipv4.gateway", "", "ipv4.dns", dns, "ipv4.ignore-auto-dns", ignore}, nil
	case "manual":
		ip, ipnet, err := net.ParseCIDR(r.Address)
		if err != nil || ip.To4() == nil {
			return nil, fmt.Errorf("Write the address with its prefix, such as 192.168.1.20/24")
		}
		if ones, _ := ipnet.Mask.Size(); ones < 8 || ones > 30 || ip.Equal(ipnet.IP) {
			return nil, fmt.Errorf("%s is a network, not an address a server can use", r.Address)
		}
		if r.Gateway != "" {
			if !validIPv4(r.Gateway) {
				return nil, fmt.Errorf("%q is not an IPv4 address", r.Gateway)
			}
			if !ipnet.Contains(net.ParseIP(r.Gateway)) {
				return nil, fmt.Errorf("The gateway %s is not on the network of %s", r.Gateway, r.Address)
			}
		}
		return []string{"ipv4.method", "manual", "ipv4.addresses", r.Address, "ipv4.gateway", r.Gateway, "ipv4.dns", dns, "ipv4.ignore-auto-dns", "yes"}, nil
	}
	return nil, fmt.Errorf("The method is auto (DHCP) or manual")
}

// busctl call output: `o "/org/freedesktop/NetworkManager/Checkpoint/3"`.
func parseCheckpoint(out string) (string, error) {
	f := strings.Fields(strings.TrimSpace(out))
	if len(f) == 2 && f[0] == "o" {
		if p := strings.Trim(f[1], `"`); reCheckpoint.MatchString(p) {
			return p, nil
		}
	}
	return "", fmt.Errorf("NetworkManager did not create a checkpoint: %s", strings.TrimSpace(out))
}

func nmCheckpointCall(method, checkpoint string) error {
	if !reCheckpoint.MatchString(checkpoint) {
		return fmt.Errorf("invalid checkpoint")
	}
	out, err := runArgv([]string{"busctl", "call", nmBus, nmPath, nmBus, method, "o", checkpoint})
	if err != nil {
		return cmdError{cmdErrMessage(out, err)}
	}
	return nil
}

func planNetworkIPv4(raw json.RawMessage) (*opPlan, *fsError) {
	var req ipv4Request
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	st := readNetworkStatus()
	if st.Unavailable != "" {
		return nil, &fsError{Code: "EUNAVAILABLE", Message: st.Unavailable}
	}
	if !reNMDevice.MatchString(req.Device) {
		return nil, &fsError{Code: "ERR", Message: "Invalid interface name"}
	}
	var iface *networkInterface
	for i := range st.Interfaces {
		if st.Interfaces[i].Device == req.Device {
			iface = &st.Interfaces[i]
		}
	}
	if iface == nil || !iface.Managed || iface.UUID == "" {
		return nil, &fsError{Code: "ERR", Message: req.Device + " has no NetworkManager connection HSI can change"}
	}
	settings, err := req.settings()
	if err != nil {
		return nil, &fsError{Code: "ERR", Message: err.Error()}
	}
	obs := map[string]string{
		"method": iface.Method, "addresses": strings.Join(iface.ConfiguredAddresses, ","),
		"gateway": iface.ConfiguredGateway, "dns": strings.Join(iface.ConfiguredDNS, ","),
	}
	uuid, conn := iface.UUID, iface.Connection
	modify := append([]string{"nmcli", "connection", "modify", uuid}, settings...)
	up := []string{"nmcli", "connection", "up", uuid}
	create := []string{"busctl", "call", nmBus, nmPath, nmBus, "CheckpointCreate", "aouu", "0", strconv.Itoa(networkConfirmSeconds), "0"}

	var checkpoint string
	reply := map[string]any{"confirmSeconds": networkConfirmSeconds}
	summary := "Use DHCP on " + req.Device
	if req.Method == "manual" {
		summary = "Give " + req.Device + " the address " + req.Address
		if req.Gateway != "" {
			summary += " through " + req.Gateway
		}
	}
	if len(req.DNS) > 0 {
		summary += ", DNS " + strings.Join(req.DNS, ", ")
	}
	steps := []planStep{
		{Kind: "run", Target: "NetworkManager", Command: create,
			Summary: fmt.Sprintf("Save the current network settings; NetworkManager puts them back unless the change is confirmed within %d seconds", networkConfirmSeconds),
			run: func() (string, error) {
				out, err := runArgv(create)
				if err != nil {
					return "", cmdError{cmdErrMessage(out, err)}
				}
				checkpoint, err = parseCheckpoint(string(out))
				reply["checkpoint"] = checkpoint
				reply["expiresAt"] = time.Now().Add(networkConfirmSeconds * time.Second).Unix()
				return "", err
			}},
		{Kind: "run", Target: conn, Command: modify, Summary: summary,
			run: func() (string, error) {
				if out, err := runArgv(modify); err != nil {
					_ = nmCheckpointCall("CheckpointRollback", checkpoint)
					return "", cmdError{cmdErrMessage(out, err) + " (previous settings restored)"}
				}
				return "", nil
			}},
		{Kind: "run", Target: req.Device, Command: up, Summary: "Apply the new settings to " + req.Device + " (the connection drops for a moment)",
			run: func() (string, error) {
				if out, err := runArgv(up); err != nil {
					_ = nmCheckpointCall("CheckpointRollback", checkpoint)
					return "", cmdError{cmdErrMessage(out, err) + " (previous settings restored)"}
				}
				return "", nil
			}},
	}
	return &opPlan{Op: "network.ipv4", Steps: steps, Observed: obs, Reply: reply}, nil
}

// Keep (Destroy) or undo (Rollback) the change a checkpoint guards.
func handleNetworkCheckpoint(method string) func(nc *nats.Conn, msg *nats.Msg) {
	return func(nc *nats.Conn, msg *nats.Msg) {
		var req struct {
			Checkpoint string `json:"checkpoint"`
		}
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			replyErr(nc, msg.Reply, badRequest(err))
			return
		}
		if err := nmCheckpointCall(method, req.Checkpoint); err != nil {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "The change was already confirmed or undone, or its time ran out: " + err.Error()})
			return
		}
		replyOk(nc, msg.Reply, map[string]bool{"ok": true})
	}
}
