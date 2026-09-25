package main

import (
	"errors"
	"testing"
)

func TestCheckHostTools(t *testing.T) {
	present := map[string]bool{"smartctl": true, "parted": true}
	tools := checkHostTools(func(cmd string) (string, error) {
		if present[cmd] {
			return "/usr/sbin/" + cmd, nil
		}
		return "", errors.New("not found")
	})
	if len(tools) != len(hostTools) {
		t.Fatalf("got %d tools, want %d", len(tools), len(hostTools))
	}
	for _, tool := range tools {
		if tool.Available != present[tool.Command] {
			t.Errorf("%s: available = %v, want %v", tool.Command, tool.Available, present[tool.Command])
		}
		if tool.Package == "" || tool.Feature == "" {
			t.Errorf("%s: package and feature must be set", tool.Command)
		}
	}
	if hostTools[0].Available {
		t.Error("checkHostTools must not mutate the shared list")
	}
}
