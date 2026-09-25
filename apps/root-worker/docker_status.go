package main

import (
	"context"
	"os/exec"
	"time"

	nats "github.com/nats-io/nats.go"
)

// dockerState tells the dashboard whether apps can run, and why not. Each
// missing piece needs a different fix (install, start the service, add the
// compose plugin), so they are reported separately.
type dockerState struct {
	Installed bool   `json:"installed"` // docker CLI present
	Running   bool   `json:"running"`   // daemon reachable
	Compose   bool   `json:"compose"`   // docker compose plugin present
	Detail    string `json:"detail,omitempty"`
}

func (s dockerState) ready() bool { return s.Installed && s.Running && s.Compose }

type commandRunner func(name string, args ...string) ([]byte, error)

func checkDocker(lookPath func(string) (string, error), run commandRunner) dockerState {
	var s dockerState
	if _, err := lookPath("docker"); err != nil {
		return s
	}
	s.Installed = true
	if out, err := run("docker", "info", "--format", "{{.ServerVersion}}"); err == nil {
		s.Running = true
	} else {
		s.Detail = cmdErrMessage(out, err)
	}
	if _, err := run("docker", "compose", "version", "--short"); err == nil {
		s.Compose = true
	}
	return s
}

func runWithTimeout(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func handleDockerStatus(nc *nats.Conn, msg *nats.Msg) {
	replyOk(nc, msg.Reply, checkDocker(exec.LookPath, runWithTimeout))
}
