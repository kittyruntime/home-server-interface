package main

import (
	"reflect"
	"testing"
)

func TestWidgetTableLastColumnKeepsSpaces(t *testing.T) {
	got := widgetTable("Filesystem Type 1B-blocks Used Avail Mounted on\n/dev/md0 ext4 4000 1000 3000 /srv/my data\nbad line\n",
		[]string{"source", "fstype", "size", "used", "avail", "target"}, true)
	want := []map[string]any{{"source": "/dev/md0", "fstype": "ext4", "size": 4000.0, "used": 1000.0, "avail": 3000.0, "target": "/srv/my data"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestWidgetValueShapes(t *testing.T) {
	if v := widgetValue(widgetCommand{}, `{"a":1}`); !reflect.DeepEqual(v, map[string]any{"a": 1.0}) {
		t.Fatalf("json: %v", v)
	}
	if v := widgetValue(widgetCommand{ndjson: true}, "{\"a\":1}\nnot json\n{\"a\":2}\n"); len(v.([]any)) != 2 {
		t.Fatalf("ndjson: %v", v)
	}
	if v := widgetValue(widgetCommand{}, "Personalities : [raid1]\n"); !reflect.DeepEqual(v, map[string]any{"text": "Personalities : [raid1]\n"}) {
		t.Fatalf("text: %v", v)
	}
}

func TestWidgetCommandsAreFixed(t *testing.T) {
	if _, err := runWidgetCommand("rm -rf /"); err == nil || err.Error() != "unknown command" {
		t.Fatalf("an unknown id must be refused: %v", err)
	}
	for id, c := range widgetCommands {
		if c.file == "" && len(c.argv) == 0 {
			t.Fatalf("%s runs nothing", id)
		}
		for _, a := range c.argv {
			if a == "sh" || a == "bash" || a == "-c" {
				t.Fatalf("%s goes through a shell", id)
			}
		}
	}
}
