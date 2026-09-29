package main

import (
	"encoding/json"

	nats "github.com/nats-io/nats.go"
)

// ── Preview and apply (#36) ──────────────────────────────────────────────────

var planBuilders = map[string]func(json.RawMessage) (*opPlan, *fsError){
	"format":      planFormat,
	"part.init":   planPartInit,
	"part.create": planPartCreate,
	"part.delete": planPartDelete,
	"pv.create":   planPvCreate,
	"vg.create":   planVgCreate,
	"lv.create":   planLvCreate,
	"lv.remove":   planLvRemove,
	"vg.remove":   planVgRemove,
	"mount":       planMount,
	"umount":      planUmount,
	"raid.create": planRaidCreate,
	"raid.stop":   planRaidStop,
}

type planPreview struct {
	Steps       []planStep `json:"steps"`
	Fingerprint string     `json:"fingerprint"`
}

type planApply struct {
	OK       bool           `json:"ok"`
	Error    string         `json:"error,omitempty"`
	Steps    []planStep     `json:"steps"`
	Results  []stepResult   `json:"results"`
	Warnings []string       `json:"warnings,omitempty"`
	Reply    map[string]any `json:"reply,omitempty"`
}

func buildPlan(op string, input json.RawMessage) (*opPlan, *fsError) {
	build, ok := planBuilders[op]
	if !ok {
		return nil, &fsError{Code: "ERR", Message: "unknown operation: " + op}
	}
	return build(input)
}

func previewPlan(op string, input json.RawMessage) (*planPreview, *fsError) {
	p, fe := buildPlan(op, input)
	if fe != nil {
		return nil, fe
	}
	return &planPreview{Steps: p.Steps, Fingerprint: p.fingerprint(input)}, nil
}

// applyPlan rebuilds the plan and runs it only if it is still the one that
// was previewed.
func applyPlan(op string, input json.RawMessage, fingerprint string) (*planApply, *fsError) {
	p, fe := buildPlan(op, input)
	if fe != nil {
		return nil, fe
	}
	if p.fingerprint(input) != fingerprint {
		return nil, &fsError{Code: "ESTALE", Message: "The server changed since this preview; review the plan again"}
	}
	results, ok, warnings := p.execute()
	out := &planApply{OK: ok, Steps: p.Steps, Results: results, Warnings: warnings, Reply: p.Reply}
	for i, r := range results {
		if r.Status == "failed" {
			out.Error = r.Error
		}
		if p.Steps[i].Deferred && r.Detail != "" {
			out.Steps[i].Diff = r.Detail
		}
	}
	logger.Info("plan applied", "op", op, "ok", ok, "warnings", len(warnings))
	return out, nil
}

func handlePlanPreview(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Op    string          `json:"op"`
		Input json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, badRequest(err))
		return
	}
	prev, fe := previewPlan(req.Op, req.Input)
	if fe != nil {
		replyErr(nc, msg.Reply, fe)
		return
	}
	replyOk(nc, msg.Reply, prev)
}

func handlePlanApply(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Op          string          `json:"op"`
		Input       json.RawMessage `json:"input"`
		Fingerprint string          `json:"fingerprint"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, badRequest(err))
		return
	}
	res, fe := applyPlan(req.Op, req.Input, req.Fingerprint)
	if fe != nil {
		replyErr(nc, msg.Reply, fe)
		return
	}
	replyOk(nc, msg.Reply, res)
}
