package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	nats "github.com/nats-io/nats.go"
)

// ── Log streaming sessions ────────────────────────────────────────────────────

var (
	logMu      sync.Mutex
	logCancels = map[string]context.CancelFunc{}
)

// ── Message types ─────────────────────────────────────────────────────────────

// dockerTaskMsg covers all docker async task payloads. HSI generates the
// compose.yaml; the worker only executes compose commands against it.
type dockerTaskMsg struct {
	JobID       string `json:"jobId"`
	Name        string `json:"name"`
	RemoveFiles bool   `json:"removeFiles"`
}

// ── Compose plumbing ──────────────────────────────────────────────────────────

const envStacksDir = "HSI_CONTAINERS_DIR"

func stacksDir() string {
	if v := os.Getenv(envStacksDir); v != "" {
		return v
	}
	return "/opt/containers"
}

var reStackName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func composeFilePath(name string) (string, error) {
	if !reStackName.MatchString(name) || name == ".." {
		return "", fmt.Errorf("invalid stack name %q", name)
	}
	return filepath.Join(stacksDir(), name, "compose.yaml"), nil
}

func composeArgs(name string, args ...string) ([]string, error) {
	p, err := composeFilePath(name)
	if err != nil {
		return nil, err
	}
	return append([]string{"compose", "-f", p}, args...), nil
}

func runCompose(name string, args ...string) error {
	full, err := composeArgs(name, args...)
	if err != nil {
		return err
	}
	_, err = runDocker(full...)
	return err
}

type networkEntry struct {
	Name   string `json:"name"`
	Driver string `json:"driver"`
}

// handleDockerComposeValidate handles root.container.composeValidate (request-reply):
// docker compose -f <path> config -q. A nonzero exit means the file is invalid;
// the combined output is surfaced as the error message.
func handleDockerComposeValidate(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil || req.Name == "" {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request: name required"})
		return
	}
	if err := runCompose(req.Name, "config", "-q"); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

func parseNetworksList(out string) []networkEntry {
	var out2 []networkEntry
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		var raw struct {
			Name   string `json:"Name"`
			Driver string `json:"Driver"`
		}
		if json.Unmarshal([]byte(line), &raw) != nil || raw.Name == "" {
			continue
		}
		out2 = append(out2, networkEntry{Name: raw.Name, Driver: raw.Driver})
	}
	return out2
}

// handleDockerNetworksList handles root.container.networksList (request-reply).
func handleDockerNetworksList(nc *nats.Conn, msg *nats.Msg) {
	out, err := runDocker("network", "ls", "--format", "{{json .}}")
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	list := parseNetworksList(out)
	if list == nil {
		list = []networkEntry{}
	}
	replyOk(nc, msg.Reply, list)
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

// ── Inspect / ListAll (sync request-reply) ────────────────────────────────────

// handleDockerInspect handles root.container.inspect (request-reply).
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

// handleDockerListAll handles root.container.listAll (request-reply).
// Returns all Docker containers with name, image, status, ports, labels, volumes, networkNames.
func handleDockerListAll(nc *nats.Conn, msg *nats.Msg) {
	idsOut, err := runDocker("ps", "-aq")
	if err != nil || strings.TrimSpace(idsOut) == "" {
		replyOk(nc, msg.Reply, []interface{}{})
		return
	}

	ids := strings.Fields(idsOut)
	args := append([]string{"inspect"}, ids...)
	out, err := runDocker(args...)
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}

	var inspects []struct {
		Name   string `json:"Name"`
		Config struct {
			Image  string            `json:"Image"`
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
		State struct {
			Status string `json:"Status"`
		} `json:"State"`
		NetworkSettings struct {
			Ports map[string][]struct {
				HostPort string `json:"HostPort"`
			} `json:"Ports"`
			Networks map[string]json.RawMessage `json:"Networks"`
		} `json:"NetworkSettings"`
		Mounts []struct {
			Type        string `json:"Type"`
			Source      string `json:"Source"`
			Destination string `json:"Destination"`
		} `json:"Mounts"`
	}
	if err := json.Unmarshal([]byte(out), &inspects); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "parse inspect: " + err.Error()})
		return
	}

	type portEntry struct {
		HostPort      int    `json:"hostPort"`
		ContainerPort int    `json:"containerPort"`
		Protocol      string `json:"protocol"`
	}
	type volumeEntry struct {
		Type   string `json:"type"`
		Source string `json:"source"`
		Target string `json:"target"`
	}
	type containerEntry struct {
		Name         string            `json:"name"`
		Image        string            `json:"image"`
		Status       string            `json:"status"`
		Ports        []portEntry       `json:"ports"`
		Labels       map[string]string `json:"labels"`
		Volumes      []volumeEntry     `json:"volumes"`
		NetworkNames []string          `json:"networkNames"`
	}

	result := make([]containerEntry, 0, len(inspects))
	for _, c := range inspects {
		entry := containerEntry{
			Name:   strings.TrimPrefix(c.Name, "/"),
			Image:  c.Config.Image,
			Status: c.State.Status,
			Labels: c.Config.Labels,
		}
		if entry.Labels == nil {
			entry.Labels = map[string]string{}
		}

		entry.Ports = []portEntry{}
		for portProto, bindings := range c.NetworkSettings.Ports {
			if len(bindings) == 0 {
				continue
			}
			parts := strings.SplitN(portProto, "/", 2)
			containerPort, _ := strconv.Atoi(parts[0])
			proto := "tcp"
			if len(parts) > 1 {
				proto = parts[1]
			}
			for _, b := range bindings {
				hostPort, _ := strconv.Atoi(b.HostPort)
				if hostPort > 0 {
					entry.Ports = append(entry.Ports, portEntry{
						HostPort:      hostPort,
						ContainerPort: containerPort,
						Protocol:      proto,
					})
				}
			}
		}

		entry.NetworkNames = make([]string, 0, len(c.NetworkSettings.Networks))
		for name := range c.NetworkSettings.Networks {
			entry.NetworkNames = append(entry.NetworkNames, name)
		}

		entry.Volumes = []volumeEntry{}
		for _, m := range c.Mounts {
			mountType := strings.ToLower(m.Type)
			if mountType == "" {
				mountType = "bind"
			}
			entry.Volumes = append(entry.Volumes, volumeEntry{
				Type:   mountType,
				Source: m.Source,
				Target: m.Destination,
			})
		}

		result = append(result, entry)
	}

	replyOk(nc, msg.Reply, result)
}

// ── Log streaming ─────────────────────────────────────────────────────────────

// handleDockerLogs starts streaming docker logs for a container to a NATS inbox.
// The caller subscribes to inbox before sending this request to avoid missing early lines.
// Each published message is JSON: {"line":"..."} or {"done":true} at the end.
func handleDockerLogs(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		ContainerName string `json:"containerName"`
		Tail          int    `json:"tail"`
		Inbox         string `json:"inbox"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request: " + err.Error()})
		return
	}
	if req.ContainerName == "" || req.Inbox == "" {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "containerName and inbox required"})
		return
	}
	tail := req.Tail
	if tail <= 0 {
		tail = 300
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)

	inbox := req.Inbox
	containerName := req.ContainerName

	logMu.Lock()
	logCancels[inbox] = cancel
	logMu.Unlock()

	go func() {
		defer func() {
			cancel()
			logMu.Lock()
			delete(logCancels, inbox)
			logMu.Unlock()
			done, _ := json.Marshal(map[string]any{"done": true})
			_ = nc.Publish(inbox, done)
		}()

		cmd := exec.CommandContext(ctx, "docker", "logs", "--follow", "--timestamps",
			"--tail", strconv.Itoa(tail), containerName)

		pr, pw := io.Pipe()
		cmd.Stdout = pw
		cmd.Stderr = pw

		if err := cmd.Start(); err != nil {
			log.Printf("docker logs %s: start failed: %v", containerName, err)
			return
		}

		go func() {
			_ = cmd.Wait()
			pw.Close()
		}()

		scanner := bufio.NewScanner(pr)
		scanner.Buffer(make([]byte, 256*1024), 256*1024)
		for scanner.Scan() {
			line := scanner.Text()
			data, _ := json.Marshal(map[string]any{"line": line})
			if err := nc.Publish(inbox, data); err != nil {
				break
			}
		}
	}()

	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

// handleDockerLogsStop cancels an active log stream started by handleDockerLogs.
func handleDockerLogsStop(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Inbox string `json:"inbox"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyOk(nc, msg.Reply, map[string]any{"ok": true})
		return
	}
	logMu.Lock()
	cancel, ok := logCancels[req.Inbox]
	if ok {
		delete(logCancels, req.Inbox)
	}
	logMu.Unlock()
	if ok {
		cancel()
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

// ── Async task dispatcher ─────────────────────────────────────────────────────

func handleDockerTask(nc *nats.Conn, msg *nats.Msg, subject string) {
	var task dockerTaskMsg
	if err := json.Unmarshal(msg.Data, &task); err != nil {
		log.Printf("docker task: malformed payload on %s: %v", subject, err)
		_ = msg.Term()
		return
	}

	var err error
	switch subject {
	case "root.container.composeUp":
		err = runCompose(task.Name, "up", "-d")
	case "root.container.composeStop":
		err = runCompose(task.Name, "stop")
	case "root.container.composeRestart":
		err = runCompose(task.Name, "restart")
	case "root.container.composeDown":
		if err = runCompose(task.Name, "down"); err == nil && task.RemoveFiles {
			dir := filepath.Dir(mustComposePath(task.Name))
			if rmErr := os.RemoveAll(dir); rmErr != nil {
				log.Printf("docker task: cleanup %s: %v", dir, rmErr)
			}
		}
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

func mustComposePath(name string) string {
	p, err := composeFilePath(name)
	if err != nil {
		log.Printf("compose path for %q: %v", name, err)
		return ""
	}
	return p
}
