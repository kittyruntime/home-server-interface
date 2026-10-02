package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	nats "github.com/nats-io/nats.go"
)

// Replacing a failed disk: mark it failed (if the kernel has not already),
// remove it from the array, add a replacement. mdadm then rebuilds onto the new
// member, which /proc/mdstat reports as "recovery".

type raidMemberReq struct {
	Name   string `json:"name"`   // md0
	Device string `json:"device"` // sdb, sdb1
}

func isMember(members []string, device string) bool {
	for _, m := range members {
		if m == "/dev/"+device {
			return true
		}
	}
	return false
}

func deviceSize(path string) (int64, error) {
	out, err := command("blockdev", "--getsize64", path).Output()
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
}

// replacementSizeProblem explains why a device is too small to replace a
// member: mdadm needs at least the size used on every member, which is the
// size of the smallest one. Returns "" when the device is large enough.
func replacementSizeProblem(device string, size int64, memberSizes []int64) string {
	if len(memberSizes) == 0 {
		return "could not read the size of the array members"
	}
	smallest := memberSizes[0]
	for _, s := range memberSizes[1:] {
		if s < smallest {
			smallest = s
		}
	}
	if size < smallest {
		return fmt.Sprintf("/dev/%s is too small: %d bytes, the array needs at least %d", device, size, smallest)
	}
	return ""
}

func handleRaidFail(nc *nats.Conn, msg *nats.Msg)   { servePlanOp(nc, msg, planRaidFail) }
func handleRaidRemove(nc *nats.Conn, msg *nats.Msg) { servePlanOp(nc, msg, planRaidRemove) }
func handleRaidAdd(nc *nats.Conn, msg *nats.Msg)    { servePlanOp(nc, msg, planRaidAdd) }

// hostMdMemberState reads the md state of one member ("in_sync", "spare",
// "faulty", ...).
var hostMdMemberState = func(md, dev string) string {
	b, _ := os.ReadFile(filepath.Join("/sys/block", md, "md", "dev-"+dev, "state"))
	return strings.TrimSpace(string(b))
}

// markRebuilding gives the disk a recovering array rebuilds onto the role
// "rebuilding": /proc/mdstat lists it like an active member.
func markRebuilding(raids []raidArray) {
	for i := range raids {
		if raids[i].SyncAction != "recovery" {
			continue
		}
		for j := range raids[i].Members {
			m := &raids[i].Members[j]
			if m.Role == "active" && strings.Contains(hostMdMemberState(raids[i].Name, m.Name), "spare") {
				m.Role = "rebuilding"
			}
		}
	}
}
