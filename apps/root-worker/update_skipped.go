package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// The staging command runs as the app user; the root worker copies its bounded
// report into the durable update result before the staging directory is removed.
func readSkippedComposeSettings(path string) ([]skippedComposeSetting, error) {
	if path == "" {
		return nil, nil
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("read skipped Compose settings: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > 1024*1024 {
		return nil, fmt.Errorf("skipped Compose settings report is not a regular file under 1 MB")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read skipped Compose settings: %w", err)
	}
	var skipped []skippedComposeSetting
	if err := json.Unmarshal(raw, &skipped); err != nil || len(skipped) == 0 || len(skipped) > 4096 {
		return nil, fmt.Errorf("invalid skipped Compose settings report")
	}
	for _, item := range skipped {
		if item.Application == "" || item.Setting == "" || item.Reason == "" || item.Remediation == "" ||
			len(item.Application) > 256 || len(item.Setting) > 1024 || len(item.Reason) > 1024 || len(item.Remediation) > 2048 {
			return nil, fmt.Errorf("invalid skipped Compose settings report item")
		}
	}
	return skipped, nil
}
