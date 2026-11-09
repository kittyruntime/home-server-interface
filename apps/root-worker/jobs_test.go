package main

import (
	"sync"
	"testing"
	"time"

	nats "github.com/nats-io/nats.go"
)

func TestJobLane(t *testing.T) {
	for subject, want := range map[string]int{
		"root.fs.copy":               fileLane,
		"root.fs.finalize":           fileLane,
		"root.fs.rename":             fileLane,
		"root.fs.mkdir":              createLane,
		"root.fs.touch":              createLane,
		"root.container.composeUp":   containerLane,
		"root.container.composeDown": containerLane,
	} {
		if got := jobLane(subject); got != want {
			t.Errorf("%s: lane %d, want %d", subject, got, want)
		}
	}
}

// A file job that never ends holds back later file jobs, not container jobs,
// and each lane keeps its order.
func TestRunJobsLanes(t *testing.T) {
	queue := make(chan *nats.Msg, 8)
	for _, s := range []string{"root.fs.copy", "root.fs.delete", "root.container.composeUp", "root.container.composeStop"} {
		queue <- &nats.Msg{Subject: s}
	}
	fetch := func() ([]*nats.Msg, error) {
		select {
		case m := <-queue:
			return []*nats.Msg{m}, nil
		case <-time.After(20 * time.Millisecond):
			return nil, nats.ErrConnectionClosed
		}
	}
	block := make(chan struct{})
	var mu sync.Mutex
	var order []string
	containersDone := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		runJobs(fetch, func(m *nats.Msg) {
			if m.Subject == "root.fs.copy" {
				<-block
			}
			mu.Lock()
			order = append(order, m.Subject)
			n := len(order)
			mu.Unlock()
			if m.Subject == "root.container.composeStop" {
				close(containersDone)
			}
			if n == 4 {
				close(finished)
			}
		})
	}()
	select {
	case <-containersDone:
	case <-time.After(2 * time.Second):
		t.Fatal("a running file job held back the container lane")
	}
	mu.Lock()
	got := append([]string(nil), order...)
	mu.Unlock()
	if len(got) != 2 || got[0] != "root.container.composeUp" || got[1] != "root.container.composeStop" {
		t.Fatalf("container lane order: %v", got)
	}
	close(block)
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("the file lane did not finish")
	}
	if order[2] != "root.fs.copy" || order[3] != "root.fs.delete" {
		t.Fatalf("file lane order: %v", order)
	}
}

// Creating a folder while a large upload is verified (finalize hashes the
// whole file, minutes for a big one) must not wait for it: on the NAS a mkdir
// took 28s behind a 240s finalize.
func TestCreateDoesNotWaitForAFileJob(t *testing.T) {
	queue := make(chan *nats.Msg, 8)
	for _, s := range []string{"root.fs.finalize", "root.fs.mkdir", "root.fs.touch"} {
		queue <- &nats.Msg{Subject: s}
	}
	fetch := func() ([]*nats.Msg, error) {
		select {
		case m := <-queue:
			return []*nats.Msg{m}, nil
		case <-time.After(20 * time.Millisecond):
			return nil, nats.ErrConnectionClosed
		}
	}
	block := make(chan struct{})
	defer close(block)
	var mu sync.Mutex
	var order []string
	created := make(chan struct{})
	go runJobs(fetch, func(m *nats.Msg) {
		if m.Subject == "root.fs.finalize" {
			<-block
		}
		mu.Lock()
		order = append(order, m.Subject)
		if m.Subject == "root.fs.touch" {
			close(created)
		}
		mu.Unlock()
	})
	select {
	case <-created:
	case <-time.After(2 * time.Second):
		t.Fatal("mkdir and touch waited for a running finalize")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(order) != 2 || order[0] != "root.fs.mkdir" || order[1] != "root.fs.touch" {
		t.Fatalf("create lane order: %v", order)
	}
}
