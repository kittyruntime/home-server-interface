package main

import (
	"errors"
	"testing"
)

func TestCheckDocker(t *testing.T) {
	found := func(string) (string, error) { return "/usr/bin/docker", nil }
	missing := func(string) (string, error) { return "", errors.New("not found") }
	runner := func(infoErr, composeErr error) commandRunner {
		return func(_ string, args ...string) ([]byte, error) {
			if args[0] == "info" {
				if infoErr != nil {
					return []byte("Cannot connect to the Docker daemon"), infoErr
				}
				return []byte("27.5.1"), nil
			}
			return []byte("2.29.1"), composeErr
		}
	}
	fail := errors.New("exit status 1")

	cases := []struct {
		name string
		got  dockerState
		want dockerState
	}{
		{"not installed", checkDocker(missing, runner(nil, nil)), dockerState{}},
		{"ready", checkDocker(found, runner(nil, nil)), dockerState{Installed: true, Running: true, Compose: true}},
		{"daemon stopped", checkDocker(found, runner(fail, nil)), dockerState{Installed: true, Compose: true, Detail: "Cannot connect to the Docker daemon"}},
		{"no compose plugin", checkDocker(found, runner(nil, fail)), dockerState{Installed: true, Running: true}},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.name, c.got, c.want)
		}
	}
	if (dockerState{Installed: true, Running: true, Compose: true}).ready() != true || (dockerState{Installed: true}).ready() {
		t.Error("ready() must require all three")
	}
}
