package main

import (
	"strings"
	"testing"
)

func TestRenderSmbConfUnavailableShare(t *testing.T) {
	conf, err := renderSmbConf([]shareDef{{Name: "data", Path: "/mnt/data/share", ValidUsers: []string{"alice"}, Unavailable: true}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(conf, "[data]") || strings.Count(conf, "   available = no\n") != 1 {
		t.Fatalf("share not disabled exactly once:\n%s", conf)
	}
	conf, err = renderSmbConf([]shareDef{{Name: "empty", Path: "/mnt/data/e", Unavailable: true}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(conf, "   available = no\n") != 1 {
		t.Fatalf("available = no written twice:\n%s", conf)
	}
}
