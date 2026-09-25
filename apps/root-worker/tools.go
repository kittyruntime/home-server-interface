package main

import (
	"os/exec"

	nats "github.com/nats-io/nats.go"
)

// hostTool is an external command a dashboard feature depends on.
type hostTool struct {
	Command   string `json:"command"`
	Package   string `json:"package"`
	Feature   string `json:"feature"`
	Available bool   `json:"available"`
}

// hostTools lists the commands storage, apps and sharing features run. The
// installer installs the required ones; this lets the dashboard explain a
// missing tool before an action fails.
var hostTools = []hostTool{
	{Command: "mdadm", Package: "mdadm", Feature: "RAID arrays"},
	{Command: "smartctl", Package: "smartmontools", Feature: "S.M.A.R.T. health"},
	{Command: "pvcreate", Package: "lvm2", Feature: "LVM volumes"},
	{Command: "parted", Package: "parted", Feature: "partitioning"},
	{Command: "mkfs.ext4", Package: "e2fsprogs", Feature: "ext4 formatting"},
	{Command: "mkfs.xfs", Package: "xfsprogs", Feature: "XFS formatting"},
	{Command: "mkfs.btrfs", Package: "btrfs-progs", Feature: "Btrfs formatting"},
	{Command: "mkfs.fat", Package: "dosfstools", Feature: "FAT32 formatting"},
	{Command: "docker", Package: "docker.io", Feature: "Apps and the App Store"},
	{Command: "smbd", Package: "samba", Feature: "SMB sharing"},
}

func checkHostTools(lookPath func(string) (string, error)) []hostTool {
	out := make([]hostTool, len(hostTools))
	for i, t := range hostTools {
		_, err := lookPath(t.Command)
		t.Available = err == nil
		out[i] = t
	}
	return out
}

func handleHostTools(nc *nats.Conn, msg *nats.Msg) {
	replyOk(nc, msg.Reply, map[string]any{"tools": checkHostTools(exec.LookPath)})
}
