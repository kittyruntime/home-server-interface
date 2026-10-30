package main

import (
	"os"
	"sync"
	"testing"
)

// runAsUser must only change the credentials of its own thread: a handler
// running as root at the same time keeps euid 0.
func TestRunAsUserDoesNotLeakToOtherThreads(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root")
	}
	inside := make(chan struct{})
	release := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	var innerEuid int
	go func() {
		defer wg.Done()
		_ = runAsUser(userCtx{uid: 65534, gid: 65534, gids: []int{65534}}, func() error {
			innerEuid = os.Geteuid()
			close(inside)
			<-release
			return nil
		})
	}()
	<-inside
	outerEuid := os.Geteuid()
	close(release)
	wg.Wait()
	if innerEuid != 65534 {
		t.Fatalf("inside runAsUser: euid = %d, want 65534", innerEuid)
	}
	if outerEuid != 0 {
		t.Fatalf("concurrent goroutine: euid = %d, want 0", outerEuid)
	}
}
