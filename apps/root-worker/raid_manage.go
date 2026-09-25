package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
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

func parseRaidMemberReq(msg *nats.Msg) (raidMemberReq, *fsError) {
	var req raidMemberReq
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		return req, &fsError{Code: "ERR", Message: "bad request: " + err.Error()}
	}
	if !reMdDev.MatchString(req.Name) {
		return req, &fsError{Code: "ERR", Message: "invalid RAID name"}
	}
	if !reBlockDev.MatchString(req.Device) {
		return req, &fsError{Code: "ERR", Message: "invalid device name"}
	}
	return req, nil
}

// arrayMembers returns the member devices of /dev/<name> as mdadm reports them.
func arrayMembers(name string) ([]string, *fsError) {
	out, err := exec.Command("mdadm", "--detail", "/dev/"+name).CombinedOutput()
	if err != nil {
		return nil, &fsError{Code: "ERR", Message: cmdErrMessage(out, err)}
	}
	members, _ := parseMdDetail(string(out))
	return members, nil
}

func isMember(members []string, device string) bool {
	for _, m := range members {
		if m == "/dev/"+device {
			return true
		}
	}
	return false
}

func manageRaid(nc *nats.Conn, msg *nats.Msg, op string) {
	req, fe := parseRaidMemberReq(msg)
	if fe != nil {
		replyErr(nc, msg.Reply, fe)
		return
	}
	if systemDeviceNames()[req.Name] && op != "--add" {
		replyErr(nc, msg.Reply, &fsError{Code: "ESYS", Message: "cannot change members of the system RAID array from HSI"})
		return
	}
	members, fe := arrayMembers(req.Name)
	if fe != nil {
		replyErr(nc, msg.Reply, fe)
		return
	}
	target := "/dev/" + req.Device
	switch op {
	case "--fail", "--remove":
		if !isMember(members, req.Device) {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: target + " is not a member of /dev/" + req.Name})
			return
		}
		// A disk that was unplugged or died completely has no device node:
		// mdadm addresses it as "detached".
		if _, err := os.Stat(target); os.IsNotExist(err) && op == "--remove" {
			target = "detached"
		}
	case "--add":
		if isMember(members, req.Device) {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: target + " is already a member of /dev/" + req.Name})
			return
		}
		if systemDeviceNames()[req.Device] {
			replyErr(nc, msg.Reply, &fsError{Code: "ESYS", Message: target + " belongs to the system disk"})
			return
		}
		if fe := checkDeviceClaimable(req.Device); fe != nil {
			replyErr(nc, msg.Reply, fe)
			return
		}
		var sizes []int64
		for _, m := range members {
			if s, err := deviceSize(m); err == nil {
				sizes = append(sizes, s)
			}
		}
		size, err := deviceSize(target)
		if err != nil {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "could not read the size of " + target + ": " + err.Error()})
			return
		}
		if p := replacementSizeProblem(req.Device, size, sizes); p != "" {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: p})
			return
		}
	}

	out, err := exec.Command("mdadm", "--manage", "/dev/"+req.Name, op, target).CombinedOutput()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: cmdErrMessage(out, err)})
		return
	}
	logger.Info("raid member changed", "array", req.Name, "op", strings.TrimPrefix(op, "--"), "device", target)
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

func deviceSize(path string) (int64, error) {
	out, err := exec.Command("blockdev", "--getsize64", path).Output()
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

func handleRaidFail(nc *nats.Conn, msg *nats.Msg)   { manageRaid(nc, msg, "--fail") }
func handleRaidRemove(nc *nats.Conn, msg *nats.Msg) { manageRaid(nc, msg, "--remove") }
func handleRaidAdd(nc *nats.Conn, msg *nats.Msg)    { manageRaid(nc, msg, "--add") }
