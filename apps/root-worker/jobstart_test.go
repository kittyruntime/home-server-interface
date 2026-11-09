package main

import (
	"encoding/json"
	"testing"

	nats "github.com/nats-io/nats.go"
)

func TestJobStartedPublishesRunning(t *testing.T) {
	type sent struct {
		subject string
		data    []byte
	}
	var got []sent
	prev := publishEvent
	publishEvent = func(_ *nats.Conn, subject string, data []byte) error {
		got = append(got, sent{subject, data})
		return nil
	}
	defer func() { publishEvent = prev }()

	jobStarted(nil, "root.fs.copy", "j1", "u")

	if len(got) != 1 || got[0].subject != "events.job.j1" {
		t.Fatalf("published %+v, want one event on events.job.j1", got)
	}
	var ev jobEvent
	if err := json.Unmarshal(got[0].data, &ev); err != nil {
		t.Fatal(err)
	}
	if ev.JobID != "j1" || ev.Status != "running" {
		t.Fatalf("event %+v, want jobId j1 status running", ev)
	}
	jobStarts.Delete("j1")
}
