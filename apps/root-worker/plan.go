package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
)

// ── Operation plans (#36) ────────────────────────────────────────────────────
// A sensitive operation is first built as a plan: the ordered steps it will
// take (files with their diff, commands, devices), each carrying its own run
// function. The same plan is shown as a preview and then executed, so the
// preview cannot drift from what runs. The fingerprint covers the plan and the
// server state it was built from; applying a plan whose fingerprint changed
// since the preview is refused.

type deviceInfo struct {
	Path     string `json:"path"`
	Model    string `json:"model,omitempty"`
	Serial   string `json:"serial,omitempty"`
	Size     int64  `json:"size,omitempty"`
	Contents string `json:"contents,omitempty"`
}

type planStep struct {
	Kind        string       `json:"kind"` // create, update, delete (file), run, start, stop, permissions
	Target      string       `json:"target"`
	Summary     string       `json:"summary"`
	Command     []string     `json:"command,omitempty"`
	Diff        string       `json:"diff,omitempty"`
	Destructive bool         `json:"destructive,omitempty"`
	Deferred    bool         `json:"deferred,omitempty"` // exact content known only once earlier steps ran
	Device      *deviceInfo  `json:"device,omitempty"`
	Devices     []deviceInfo `json:"devices,omitempty"`   // every device a destructive step erases
	OnFailure   string       `json:"onFailure,omitempty"` // "" stop, "warn", "ignore"

	run      func() (detail string, err error)
	failCode string // error code when this step fails (default ERR)
}

type opPlan struct {
	Op       string
	Steps    []planStep
	Observed map[string]string
	Reply    map[string]any // merged into the success reply
	// FingerprintInput replaces the input in the fingerprint when set (an
	// input carrying a secret, such as a password).
	FingerprintInput json.RawMessage
	// Storage descriptions (#37) refreshed once the plan succeeded: the
	// volumes it touched (by mount point), the ones it removed, and every
	// volume on an array whose members it changed.
	Describe          []string
	Forget            []string
	DescribeArrayUUID string
}

type stepResult struct {
	Status string `json:"status"` // done, failed, warning, skipped, not-run
	Error  string `json:"error,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// runArgv runs a command step; tests swap it to record or forbid execution.
var runArgv = func(argv []string) ([]byte, error) {
	return command(argv[0], argv[1:]...).CombinedOutput()
}

// runStdin runs a command step that reads a secret on stdin; tests swap it.
var runStdin = func(argv []string, stdin string) ([]byte, error) {
	c := command(argv[0], argv[1:]...)
	c.Stdin = strings.NewReader(stdin)
	return c.CombinedOutput()
}

type cmdError struct{ msg string }

func (e cmdError) Error() string { return e.msg }

func cmdStep(target, summary string, argv []string) planStep {
	return planStep{Kind: "run", Target: target, Summary: summary, Command: argv, run: func() (string, error) {
		out, err := runArgv(argv)
		if err != nil {
			return "", cmdError{cmdErrMessage(out, err)}
		}
		return "", nil
	}}
}

func (p *opPlan) fingerprint(input json.RawMessage) string {
	if p.FingerprintInput != nil {
		input = p.FingerprintInput
	}
	var decoded any
	_ = json.Unmarshal(input, &decoded)
	steps := make([]planStep, len(p.Steps))
	copy(steps, p.Steps)
	for i := range steps {
		if steps[i].Deferred {
			steps[i].Diff = ""
		}
	}
	b, _ := json.Marshal(struct {
		Op       string            `json:"op"`
		Input    any               `json:"input"`
		Steps    []planStep        `json:"steps"`
		Observed map[string]string `json:"observed"`
	}{p.Op, decoded, steps, p.Observed})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// execute runs the steps in order. A failing "stop" step (the default) halts
// the plan; "warn" failures are collected and the plan continues; "ignore"
// failures are best effort.
func (p *opPlan) execute() (results []stepResult, ok bool, warnings []string) {
	results = make([]stepResult, len(p.Steps))
	for i := range results {
		results[i].Status = "not-run"
	}
	for i, s := range p.Steps {
		var detail string
		var err error
		if s.run != nil {
			detail, err = s.run()
		}
		results[i].Detail = detail
		if err == nil {
			results[i].Status = "done"
			continue
		}
		switch s.OnFailure {
		case "warn":
			results[i].Status = "warning"
			results[i].Error = err.Error()
			warnings = append(warnings, s.Summary+": "+err.Error())
		case "ignore":
			results[i].Status = "skipped"
			results[i].Error = err.Error()
		default:
			results[i].Status = "failed"
			results[i].Error = err.Error()
			return results, false, warnings
		}
	}
	return results, true, warnings
}
