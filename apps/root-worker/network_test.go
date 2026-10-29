package main

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// A server with NetworkManager managing eth0 by DHCP, and an unmanaged lo.
func stubNetworkManager(t *testing.T, container string) {
	t.Helper()
	prevOut, prevContainer, prevRunning, prevCheckpoints := hostOutput, hostContainer, nmRunning, nmCheckpoints
	t.Cleanup(func() {
		hostOutput, hostContainer, nmRunning, nmCheckpoints = prevOut, prevContainer, prevRunning, prevCheckpoints
	})
	nmCheckpoints = func() []string { return []string{} }
	hostContainer = func() string { return container }
	nmRunning = func() bool { return true }
	hostOutput = func(name string, args ...string) ([]byte, error) {
		cmd := name + " " + strings.Join(args, " ")
		switch {
		case strings.HasSuffix(cmd, "device status"):
			return []byte("eth0:ethernet:connected:0c8f0e6a-6b55-4c38-9e1c-2a8c4a7b9f10\nlo:loopback:connected (externally):\n"), nil
		case strings.HasSuffix(cmd, "device show eth0"):
			return []byte("IP4.ADDRESS[1]:192.168.1.20/24\nIP4.GATEWAY:192.168.1.1\nIP4.DNS[1]:192.168.1.1\n"), nil
		case strings.HasSuffix(cmd, "connection show 0c8f0e6a-6b55-4c38-9e1c-2a8c4a7b9f10"):
			return []byte("connection.id:Wired connection 1\nipv4.method:auto\nipv4.addresses:\nipv4.gateway:--\nipv4.dns:\n"), nil
		}
		return nil, errors.New("unexpected " + cmd)
	}
}

func TestNetworkStatusReadsNetworkManager(t *testing.T) {
	stubNetworkManager(t, "")
	st := readNetworkStatus()
	if st.Unavailable != "" || len(st.Interfaces) != 1 {
		t.Fatalf("status %+v", st)
	}
	i := st.Interfaces[0]
	if !i.Managed || i.Method != "auto" || i.Connection != "Wired connection 1" || i.Gateway != "192.168.1.1" ||
		strings.Join(i.Addresses, ",") != "192.168.1.20/24" || strings.Join(i.DNS, ",") != "192.168.1.1" || i.ConfiguredGateway != "" {
		t.Fatalf("interface %+v", i)
	}
}

func TestNetworkIsLeftToTheContainerHost(t *testing.T) {
	stubNetworkManager(t, "lxc")
	st := readNetworkStatus()
	if st.Container != "lxc" || !strings.Contains(st.Unavailable, "container host") || len(st.Interfaces) != 0 {
		t.Fatalf("status %+v", st)
	}
	if _, err := planNetworkIPv4(json.RawMessage(`{"device":"eth0","method":"auto"}`)); err == nil || err.Code != "EUNAVAILABLE" {
		t.Fatalf("a plan was built in a container: %+v", err)
	}
}

func TestIPv4RequestValidation(t *testing.T) {
	bad := []ipv4Request{
		{Method: "manual", Address: "192.168.1.20"},                         // no prefix
		{Method: "manual", Address: "192.168.1.0/24"},                       // the network itself
		{Method: "manual", Address: "192.168.1.20/24", Gateway: "10.0.0.1"}, // gateway off the network
		{Method: "manual", Address: "192.168.1.20/24", DNS: []string{"dns.example"}},
		{Method: "auto", DNS: []string{"1.1.1.1", "8.8.8.8", "9.9.9.9", "1.0.0.1"}},
		{Method: "static"},
	}
	for _, r := range bad {
		if _, err := r.settings(); err == nil {
			t.Errorf("accepted %+v", r)
		}
	}
	s, err := ipv4Request{Method: "manual", Address: "192.168.1.20/24", Gateway: "192.168.1.1", DNS: []string{"1.1.1.1"}}.settings()
	if err != nil || strings.Join(s, " ") != "ipv4.method manual ipv4.addresses 192.168.1.20/24 ipv4.gateway 192.168.1.1 ipv4.dns 1.1.1.1 ipv4.ignore-auto-dns yes" {
		t.Fatalf("manual settings %q %v", s, err)
	}
	s, _ = ipv4Request{Method: "auto"}.settings()
	if strings.Join(s, "|") != "ipv4.method|auto|ipv4.addresses||ipv4.gateway||ipv4.dns||ipv4.ignore-auto-dns|no" {
		t.Fatalf("auto settings %q", s)
	}
}

func TestNetworkChangeRunsUnderACheckpoint(t *testing.T) {
	stubNetworkManager(t, "")
	var ran []string
	prev := runArgv
	t.Cleanup(func() { runArgv = prev })
	runArgv = func(argv []string) ([]byte, error) {
		cmd := strings.Join(argv, " ")
		ran = append(ran, cmd)
		if strings.Contains(cmd, "CheckpointCreate") {
			return []byte(`o "/org/freedesktop/NetworkManager/Checkpoint/7"` + "\n"), nil
		}
		return nil, nil
	}
	p, ferr := planNetworkIPv4(json.RawMessage(`{"device":"eth0","method":"manual","address":"192.168.1.30/24","gateway":"192.168.1.1"}`))
	if ferr != nil {
		t.Fatal(ferr.Message)
	}
	if _, ok, _ := p.execute(); !ok {
		t.Fatalf("plan failed: %v", ran)
	}
	if len(ran) != 3 || !strings.Contains(ran[0], "CheckpointCreate aouu 0 120 0") ||
		!strings.HasPrefix(ran[1], "nmcli connection modify 0c8f0e6a") || !strings.HasPrefix(ran[2], "nmcli connection up 0c8f0e6a") {
		t.Fatalf("ran %q", ran)
	}
	if p.Reply["checkpoint"] != "/org/freedesktop/NetworkManager/Checkpoint/7" {
		t.Fatalf("reply %+v", p.Reply)
	}
}

func TestFailedNetworkChangeIsUndoneAtOnce(t *testing.T) {
	stubNetworkManager(t, "")
	var ran []string
	prev := runArgv
	t.Cleanup(func() { runArgv = prev })
	runArgv = func(argv []string) ([]byte, error) {
		cmd := strings.Join(argv, " ")
		ran = append(ran, cmd)
		switch {
		case strings.Contains(cmd, "CheckpointCreate"):
			return []byte(`o "/org/freedesktop/NetworkManager/Checkpoint/8"`), nil
		case strings.HasPrefix(cmd, "nmcli connection up"):
			return []byte("Error: Connection activation failed"), errors.New("exit status 4")
		}
		return nil, nil
	}
	p, _ := planNetworkIPv4(json.RawMessage(`{"device":"eth0","method":"auto","dns":["1.1.1.1"]}`))
	results, ok, _ := p.execute()
	if ok || results[2].Status != "failed" || !strings.Contains(results[2].Error, "previous settings restored") {
		t.Fatalf("results %+v", results)
	}
	if last := ran[len(ran)-1]; last != "busctl call org.freedesktop.NetworkManager /org/freedesktop/NetworkManager org.freedesktop.NetworkManager CheckpointRollback o /org/freedesktop/NetworkManager/Checkpoint/8" {
		t.Fatalf("no rollback: %q", ran)
	}
}

func TestCheckpointPathsAreChecked(t *testing.T) {
	if _, err := parseCheckpoint(`o "/org/freedesktop/NetworkManager/Checkpoint/1; rm"`); err == nil {
		t.Fatal("accepted a bad checkpoint path")
	}
	if err := nmCheckpointCall("CheckpointDestroy", "/tmp/x"); err == nil {
		t.Fatal("called NetworkManager with a bad path")
	}
}

func TestPendingCheckpointsAreListed(t *testing.T) {
	got := parseCheckpoints(`ao 2 "/org/freedesktop/NetworkManager/Checkpoint/3" "/org/freedesktop/NetworkManager/Checkpoint/4"`)
	if strings.Join(got, ",") != "/org/freedesktop/NetworkManager/Checkpoint/3,/org/freedesktop/NetworkManager/Checkpoint/4" {
		t.Fatalf("got %q", got)
	}
	if got := parseCheckpoints("ao 0"); len(got) != 0 {
		t.Fatalf("got %q", got)
	}
}
