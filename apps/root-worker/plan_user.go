package main

import (
	"encoding/json"
	"os/user"
	"strings"
)

// ── Plan builders: user accounts (#36) ──────────────────────────────────────

var (
	hostUserExists   = func(name string) bool { _, err := user.Lookup(name); return err == nil }
	hostGroupMembers = func(group string) []string {
		b, _ := hostReadFile("/etc/group")
		for _, line := range strings.Split(string(b), "\n") {
			f := strings.Split(line, ":")
			if len(f) == 4 && f[0] == group && f[3] != "" {
				return strings.Split(f[3], ",")
			}
		}
		return nil
	}
)

// stdinStep is a command step whose secret goes on stdin: the plan shows the
// command, never the secret.
func stdinStep(target, summary string, argv []string, stdin string) planStep {
	return planStep{Kind: "run", Target: target, Summary: summary, Command: argv, OnFailure: "warn", run: func() (string, error) {
		out, err := runStdin(argv, stdin)
		if err != nil {
			return "", cmdError{cmdErrMessage(out, err)}
		}
		return "", nil
	}}
}

func planUserCreate(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Samba    bool   `json:"samba"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if !reLinuxUsername.MatchString(req.Username) {
		return nil, &fsError{Code: "ERR", Message: "invalid linux username: must match ^[a-z_][a-z0-9_-]{0,31}$"}
	}
	if req.Password == "" || strings.ContainsAny(req.Password, "\n\r") {
		return nil, &fsError{Code: "ERR", Message: "invalid password"}
	}
	exists := hostUserExists(req.Username)
	smb := req.Samba && hostLookPath("smbpasswd")
	var steps []planStep
	if !exists {
		steps = append(steps, cmdStep(req.Username, "Create the Linux account "+req.Username+" without a home directory or shell login",
			[]string{"useradd", "-M", "-s", "/sbin/nologin", req.Username}))
	}
	steps = append(steps, stdinStep(req.Username, "Set the Linux password to the one you typed (not shown)",
		[]string{"chpasswd"}, req.Username+":"+req.Password+"\n"))
	if smb {
		steps = append(steps, stdinStep(req.Username, "Create the Samba account with the same password (not shown)",
			[]string{"smbpasswd", "-s", "-a", req.Username}, req.Password+"\n"+req.Password+"\n"))
	}
	// The fingerprint travels to the client and the audit log: an unsalted
	// hash of the password there could be brute-forced offline.
	fin, _ := json.Marshal(map[string]any{"username": req.Username, "samba": req.Samba})
	obs := map[string]string{"exists": boolStr(exists), "smbpasswd": boolStr(hostLookPath("smbpasswd"))}
	return &opPlan{Op: "user.create", Steps: steps, Observed: obs, FingerprintInput: fin}, nil
}

func planGroupLeave(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Username string `json:"username"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || !reLinuxUsername.MatchString(req.Username) {
		return nil, &fsError{Code: "ERR", Message: "invalid linux username"}
	}
	members := hostGroupMembers(shareGroup)
	var steps []planStep
	for _, m := range members {
		if m == req.Username {
			steps = append(steps, cmdStep(shareGroup, "Remove "+req.Username+" from the "+shareGroup+" group, which grants write access to shared folders",
				[]string{"gpasswd", "-d", req.Username, shareGroup}))
		}
	}
	return &opPlan{Op: "group.leave", Steps: steps, Observed: map[string]string{"members": sortedJoin(members)}}, nil
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
