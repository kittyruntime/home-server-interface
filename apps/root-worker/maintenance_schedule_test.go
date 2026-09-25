package main

import (
	"testing"
	"time"
)

func at(s string) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04", s, time.UTC)
	if err != nil {
		panic(err)
	}
	return t
}

func TestIsDue(t *testing.T) {
	weekly := taskSchedule{Every: "weekly", Weekday: 0, Hour: 2, Day: 1} // Sunday 02:00
	sunday2 := at("2026-09-27 02:30")                                    // a Sunday
	if !weekly.isDue(sunday2, nil) {
		t.Error("weekly task must be due in its slot")
	}
	if weekly.isDue(at("2026-09-27 03:00"), nil) {
		t.Error("not due outside its hour")
	}
	if weekly.isDue(at("2026-09-28 02:00"), nil) {
		t.Error("not due on another weekday")
	}
	recent := sunday2.Add(-time.Hour)
	if weekly.isDue(sunday2, &recent) {
		t.Error("not due again right after a run")
	}
	lastWeek := sunday2.Add(-7 * 24 * time.Hour)
	if !weekly.isDue(sunday2, &lastWeek) {
		t.Error("due again a week later")
	}
	if (taskSchedule{Every: "off", Hour: 2, Day: 1}).isDue(sunday2, nil) {
		t.Error("off is never due")
	}
}

func TestNextRun(t *testing.T) {
	monthly := taskSchedule{Every: "monthly", Day: 1, Hour: 3}
	got := monthly.nextRun(at("2026-09-25 10:00"))
	if got == nil || !got.Equal(at("2026-10-01 03:00")) {
		t.Errorf("nextRun = %v", got)
	}
	daily := taskSchedule{Every: "daily", Hour: 2, Day: 1}
	if got := daily.nextRun(at("2026-09-25 01:59")); got == nil || !got.Equal(at("2026-09-25 02:00")) {
		t.Errorf("daily nextRun = %v", got)
	}
	if (taskSchedule{Every: "off", Day: 1}).nextRun(at("2026-09-25 10:00")) != nil {
		t.Error("off has no next run")
	}
}

func TestScheduleValidation(t *testing.T) {
	if !defaultMaintenanceConfig().SmartShort.valid() {
		t.Error("defaults must be valid")
	}
	for _, s := range []taskSchedule{
		{Every: "hourly", Day: 1}, {Every: "daily", Hour: 24, Day: 1}, {Every: "monthly", Day: 31, Hour: 1},
	} {
		if s.valid() {
			t.Errorf("%+v must be invalid", s)
		}
	}
}
