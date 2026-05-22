package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"time"

	nats "github.com/nats-io/nats.go"
)

// ── Message types ─────────────────────────────────────────────────────────────

type portMapping struct {
	HostPort      int    `json:"hostPort"`
	ContainerPort int    `json:"containerPort"`
	Protocol      string `json:"protocol"` // tcp | udp
}

type envVar struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type volumeMount struct {
	Type   string `json:"type"`   // bind | named | place (place already resolved to bind by backend)
	Source string `json:"source"` // host path or named volume name
	Target string `json:"target"` // container path
}

type labelEntry struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// dockerTaskMsg covers all docker async task payloads in a single struct.
type dockerTaskMsg struct {
	JobID string `json:"jobId"`

	// Container fields
	ContainerName string        `json:"containerName"`
	Image         string        `json:"image"`
	Ports         []portMapping `json:"ports"`
	Envs          []envVar      `json:"envs"`
	Volumes       []volumeMount `json:"volumes"`
	NetworkNames  []string      `json:"networkNames"`
	Labels        []labelEntry  `json:"labels"`
	CapAdd        []string      `json:"capAdd"`
	CapDrop       []string      `json:"capDrop"`
	RestartPolicy string        `json:"restartPolicy"`
	Hostname      *string       `json:"hostname"`
	User          *string       `json:"user"`
	Command       *string       `json:"command"`
	CPULimit      *float64      `json:"cpuLimit"`    // e.g. 0.5, 2.0
	MemoryLimit   *string       `json:"memoryLimit"` // e.g. "512m", "2g"

	// Network fields
	NetworkName string  `json:"networkName"`
	Driver      string  `json:"driver"`
	Subnet      *string `json:"subnet"`
	Gateway     *string `json:"gateway"`

	// Volume fields
	VolumeName string `json:"volumeName"`
}

// ── Docker CLI runner ─────────────────────────────────────────────────────────

// runDocker executes a docker CLI command with a 5-minute timeout.
// Returns trimmed stdout+stderr on success, or an error with the output embedded.
func runDocker(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", args...)
	out, err := cmd.CombinedOutput()
	output := strings.TrimSpace(string(out))
	if err != nil {
		if output != "" {
			return "", fmt.Errorf("%s", output)
		}
		return "", err
	}
	return output, nil
}

// ── Container operations ──────────────────────────────────────────────────────

// buildCreateArgs builds the argument list for `docker run -d`.
func buildCreateArgs(msg *dockerTaskMsg) []string {
	args := []string{"run", "-d", "--name", msg.ContainerName}

	for _, p := range msg.Ports {
		proto := p.Protocol
		if proto == "" {
			proto = "tcp"
		}
		args = append(args, "-p", fmt.Sprintf("%d:%d/%s", p.HostPort, p.ContainerPort, proto))
	}

	for _, e := range msg.Envs {
		args = append(args, "-e", fmt.Sprintf("%s=%s", e.Key, e.Value))
	}

	for _, v := range msg.Volumes {
		args = append(args, "-v", fmt.Sprintf("%s:%s", v.Source, v.Target))
	}

	// First network via --network; additional ones connected after start.
	if len(msg.NetworkNames) > 0 {
		args = append(args, "--network", msg.NetworkNames[0])
	}

	for _, l := range msg.Labels {
		args = append(args, "--label", fmt.Sprintf("%s=%s", l.Key, l.Value))
	}

	for _, c := range msg.CapAdd {
		args = append(args, "--cap-add", c)
	}
	for _, c := range msg.CapDrop {
		args = append(args, "--cap-drop", c)
	}

	if msg.RestartPolicy != "" && msg.RestartPolicy != "no" {
		args = append(args, "--restart", msg.RestartPolicy)
	}

	if msg.Hostname != nil && *msg.Hostname != "" {
		args = append(args, "--hostname", *msg.Hostname)
	}

	if msg.User != nil && *msg.User != "" {
		args = append(args, "--user", *msg.User)
	}

	if msg.CPULimit != nil && *msg.CPULimit > 0 {
		args = append(args, "--cpus", fmt.Sprintf("%.2f", *msg.CPULimit))
	}

	if msg.MemoryLimit != nil && *msg.MemoryLimit != "" {
		args = append(args, "--memory", *msg.MemoryLimit)
	}

	args = append(args, msg.Image)

	if msg.Command != nil && *msg.Command != "" {
		args = append(args, strings.Fields(*msg.Command)...)
	}

	return args
}

func doContainerCreate(msg *dockerTaskMsg) error {
	if _, err := runDocker(buildCreateArgs(msg)...); err != nil {
		return fmt.Errorf("docker run: %w", err)
	}
	// Connect additional networks (beyond the first).
	for i := 1; i < len(msg.NetworkNames); i++ {
		if _, err := runDocker("network", "connect", msg.NetworkNames[i], msg.ContainerName); err != nil {
			log.Printf("warn: connect %s to network %s: %v", msg.ContainerName, msg.NetworkNames[i], err)
		}
	}
	return nil
}

func doContainerRecreate(msg *dockerTaskMsg) error {
	_, _ = runDocker("stop", msg.ContainerName)
	_, _ = runDocker("rm", "-f", msg.ContainerName)
	return doContainerCreate(msg)
}

func doContainerStart(name string) error {
	_, err := runDocker("start", name)
	return err
}

func doContainerStop(name string) error {
	_, err := runDocker("stop", name)
	return err
}

func doContainerRestart(name string) error {
	_, err := runDocker("restart", name)
	return err
}

func doContainerRemove(name string) error {
	_, err := runDocker("rm", "-f", name)
	return err
}

// ── Network operations ────────────────────────────────────────────────────────

func doNetworkCreate(msg *dockerTaskMsg) error {
	args := []string{"network", "create"}
	if msg.Driver != "" {
		args = append(args, "--driver", msg.Driver)
	}
	if msg.Subnet != nil && *msg.Subnet != "" {
		args = append(args, "--subnet", *msg.Subnet)
	}
	if msg.Gateway != nil && *msg.Gateway != "" {
		args = append(args, "--gateway", *msg.Gateway)
	}
	args = append(args, msg.NetworkName)
	_, err := runDocker(args...)
	return err
}

func doNetworkRemove(name string) error {
	_, err := runDocker("network", "rm", name)
	return err
}

// ── Volume operations ─────────────────────────────────────────────────────────

func doVolumeCreate(name string) error {
	_, err := runDocker("volume", "create", name)
	return err
}

func doVolumeRemove(name string) error {
	_, err := runDocker("volume", "rm", name)
	return err
}

// ── Inspect (sync request-reply) ──────────────────────────────────────────────

// handleDockerInspect handles brume.root.docker.container.inspect (request-reply).
// Returns {"status":"running","running":true,"exitCode":0} or similar.
func handleDockerInspect(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		ContainerName string `json:"containerName"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request: " + err.Error()})
		return
	}
	if req.ContainerName == "" {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "containerName required"})
		return
	}

	const tpl = `{"status":"{{.State.Status}}","running":{{.State.Running}},"exitCode":{{.State.ExitCode}}}`
	out, err := runDocker("inspect", "--format", tpl, req.ContainerName)
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}

	var state map[string]interface{}
	if err := json.Unmarshal([]byte(out), &state); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "parse inspect: " + err.Error()})
		return
	}
	replyOk(nc, msg.Reply, state)
}

// ── Async task dispatcher ─────────────────────────────────────────────────────

// handleDockerTask handles all brume.root.docker.* JetStream messages.
func handleDockerTask(nc *nats.Conn, msg *nats.Msg, subject string) {
	var task dockerTaskMsg
	if err := json.Unmarshal(msg.Data, &task); err != nil {
		log.Printf("docker task: malformed payload on %s: %v", subject, err)
		_ = msg.Term()
		return
	}

	var err error
	switch subject {
	case "brume.root.docker.container.create":
		err = doContainerCreate(&task)
	case "brume.root.docker.container.recreate":
		err = doContainerRecreate(&task)
	case "brume.root.docker.container.start":
		err = doContainerStart(task.ContainerName)
	case "brume.root.docker.container.stop":
		err = doContainerStop(task.ContainerName)
	case "brume.root.docker.container.restart":
		err = doContainerRestart(task.ContainerName)
	case "brume.root.docker.container.remove":
		err = doContainerRemove(task.ContainerName)
	case "brume.root.docker.network.create":
		err = doNetworkCreate(&task)
	case "brume.root.docker.network.remove":
		err = doNetworkRemove(task.NetworkName)
	case "brume.root.docker.volume.create":
		err = doVolumeCreate(task.VolumeName)
	case "brume.root.docker.volume.remove":
		err = doVolumeRemove(task.VolumeName)
	default:
		log.Printf("docker task: unknown subject %s", subject)
		_ = msg.Term()
		return
	}

	if err != nil {
		log.Printf("docker task: %s failed: %v", subject, err)
		_ = msg.Nak()
		publishJobResult(nc, task.JobID, "failed", nil, err.Error())
	} else {
		_ = msg.Ack()
		publishJobResult(nc, task.JobID, "completed", map[string]bool{"ok": true}, "")
	}
}
