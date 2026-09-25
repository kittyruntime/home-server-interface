package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestEvalSmart(t *testing.T) {
	cases := []struct {
		name          string
		json          string
		wantAvailable bool
		wantHealth    string
		wantWarnings  []string
	}{
		{
			name:          "healthy SATA disk",
			json:          `{"smartctl":{"exit_status":0},"smart_status":{"passed":true},"ata_smart_attributes":{"table":[{"id":5,"name":"Reallocated_Sector_Ct"}]}}`,
			wantAvailable: true, wantHealth: "passed",
		},
		{
			name:          "failing disk",
			json:          `{"smartctl":{"exit_status":8},"smart_status":{"passed":false},"ata_smart_attributes":{"table":[{"id":5}]}}`,
			wantAvailable: true, wantHealth: "failed",
		},
		{
			name:          "virtio disk without SMART",
			json:          `{"smartctl":{"exit_status":1}}`,
			wantAvailable: false, wantHealth: "unknown",
		},
		{
			name:          "USB bridge with attributes but no overall status",
			json:          `{"smartctl":{"exit_status":4},"ata_smart_attributes":{"table":[{"id":194}]}}`,
			wantAvailable: true, wantHealth: "unknown",
			wantWarnings: []string{"some SMART commands failed or returned a checksum error"},
		},
		{
			name:          "passing disk with self-test errors stays available",
			json:          `{"smartctl":{"exit_status":128},"smart_status":{"passed":true},"ata_smart_attributes":{"table":[{"id":5}]}}`,
			wantAvailable: true, wantHealth: "passed",
			wantWarnings: []string{"the self-test log contains errors"},
		},
		{
			name:          "NVMe drive",
			json:          `{"smartctl":{"exit_status":0},"smart_status":{"passed":true},"nvme_smart_health_information_log":{"temperature":35,"available_spare":100}}`,
			wantAvailable: true, wantHealth: "passed",
		},
		{
			name:          "disk in standby (-n standby)",
			json:          `{"smartctl":{"exit_status":2}}`,
			wantAvailable: false, wantHealth: "unknown",
		},
	}
	for _, c := range cases {
		var sc smartctlJSON
		if err := json.Unmarshal([]byte(c.json), &sc); err != nil {
			t.Fatalf("%s: bad fixture: %v", c.name, err)
		}
		available, health, warnings := evalSmart(sc)
		if !available {
			wantUnsupported := c.name == "virtio disk without SMART"
			if got := smartUnsupported(sc); got != wantUnsupported {
				t.Errorf("%s: smartUnsupported() = %v, want %v", c.name, got, wantUnsupported)
			}
		}
		if available != c.wantAvailable || health != c.wantHealth || !reflect.DeepEqual(warnings, c.wantWarnings) {
			t.Errorf("%s: evalSmart() = (%v, %q, %v), want (%v, %q, %v)",
				c.name, available, health, warnings, c.wantAvailable, c.wantHealth, c.wantWarnings)
		}
	}
}
