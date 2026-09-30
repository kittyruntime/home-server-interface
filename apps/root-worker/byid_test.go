package main

import "testing"

func TestPreferredByID(t *testing.T) {
	links := map[string]string{
		"wwn-0x5000c500a1b2c3d4":                   "sda",
		"ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1":       "sda",
		"scsi-SATA_WDC_WD40EFRX-68N_WD-WCC7K1":     "sda",
		"ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1-part1": "sda1",
		"nvme-eui.0025385b71b0a1b2":                "nvme0n1",
		"nvme-Samsung_SSD_970_EVO_S4EWNX0N":        "nvme0n1",
		"wwn-0x600508b1001c":                       "sdb",
	}
	got := preferredByID(links)
	want := map[string]string{
		"sda":     "ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1",
		"sda1":    "ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1-part1",
		"nvme0n1": "nvme-Samsung_SSD_970_EVO_S4EWNX0N",
		"sdb":     "wwn-0x600508b1001c",
	}
	for dev, name := range want {
		if got[dev] != name {
			t.Errorf("%s: got %q, want %q", dev, got[dev], name)
		}
	}
}

func TestAssignByID(t *testing.T) {
	devs := []BlockDev{{Name: "sda", Children: []BlockDev{{Name: "sda1"}}}}
	assignByID(devs, map[string]string{"sda": "ata-X", "sda1": "ata-X-part1"})
	if devs[0].ByID != "ata-X" || devs[0].Children[0].ByID != "ata-X-part1" {
		t.Fatalf("by-id not assigned: %+v", devs)
	}
}
