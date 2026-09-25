package main

import "time"

// Scheduled disk maintenance: SMART self-tests and md consistency checks.
// The schedule lives in /etc/hsi/maintenance.json and is run by a systemd
// timer (`hsi-root-worker maintenance`, hourly), so it keeps working when the
// dashboard or the backend is down.

type taskSchedule struct {
	// off | daily | weekly | monthly
	Every   string `json:"every"`
	Weekday int    `json:"weekday"` // 0 = Sunday, for weekly
	Day     int    `json:"day"`     // 1-28, for monthly
	Hour    int    `json:"hour"`    // 0-23, local time
}

type maintenanceConfig struct {
	SmartShort taskSchedule `json:"smartShort"`
	SmartLong  taskSchedule `json:"smartLong"`
	RaidCheck  taskSchedule `json:"raidCheck"`
}

// Defaults: a short SMART test every week and a long one every month, at
// night. The RAID check is off because Ubuntu's mdadm package already runs a
// monthly one (mdcheck_start.timer).
func defaultMaintenanceConfig() maintenanceConfig {
	return maintenanceConfig{
		SmartShort: taskSchedule{Every: "weekly", Weekday: 0, Day: 1, Hour: 2},
		SmartLong:  taskSchedule{Every: "monthly", Day: 1, Hour: 3},
		RaidCheck:  taskSchedule{Every: "off", Day: 1, Hour: 1},
	}
}

func (s taskSchedule) valid() bool {
	switch s.Every {
	case "off", "daily", "weekly", "monthly":
	default:
		return false
	}
	return s.Hour >= 0 && s.Hour <= 23 && s.Weekday >= 0 && s.Weekday <= 6 && s.Day >= 1 && s.Day <= 28
}

// slotMatches reports whether t falls in the scheduled hour.
func (s taskSchedule) slotMatches(t time.Time) bool {
	if t.Hour() != s.Hour {
		return false
	}
	switch s.Every {
	case "daily":
		return true
	case "weekly":
		return int(t.Weekday()) == s.Weekday
	case "monthly":
		return t.Day() == s.Day
	}
	return false
}

// isDue reports whether the task should run at now: it is in its scheduled
// hour and has not already run in the last 23 hours (the timer fires hourly,
// and a manual run just before the slot counts).
func (s taskSchedule) isDue(now time.Time, lastRun *time.Time) bool {
	if s.Every == "off" || !s.slotMatches(now) {
		return false
	}
	return lastRun == nil || now.Sub(*lastRun) >= 23*time.Hour
}

// nextRun returns the next start of a scheduled slot after from, or nil when off.
func (s taskSchedule) nextRun(from time.Time) *time.Time {
	if s.Every == "off" {
		return nil
	}
	t := time.Date(from.Year(), from.Month(), from.Day(), from.Hour(), 0, 0, 0, from.Location()).Add(time.Hour)
	for i := 0; i < 24*62; i++ { // at most two months of hourly slots
		if s.slotMatches(t) {
			return &t
		}
		t = t.Add(time.Hour)
	}
	return nil
}
