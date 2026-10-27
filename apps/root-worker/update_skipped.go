package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"syscall"
)

const skippedComposeSettingsMaxBytes = 1024 * 1024

// The staging command runs as the app user; the root worker copies its bounded
// report into the durable update result before the staging directory is removed.
func readSkippedComposeSettings(path string) ([]skippedComposeSetting, error) {
	if path == "" {
		return nil, nil
	}
	dir, base, err := openParentNoFollow(path)
	if err != nil {
		return nil, fmt.Errorf("read skipped Compose settings: %w", err)
	}
	defer dir.Close()
	fd, err := syscall.Openat(int(dir.Fd()), base, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("read skipped Compose settings: %w", err)
	}
	f := os.NewFile(uintptr(fd), base)
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return nil, fmt.Errorf("read skipped Compose settings: %w", err)
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Size > skippedComposeSettingsMaxBytes {
		return nil, fmt.Errorf("skipped Compose settings report is not a regular file under 1 MB")
	}
	raw, err := io.ReadAll(io.LimitReader(f, skippedComposeSettingsMaxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read skipped Compose settings: %w", err)
	}
	if len(raw) > skippedComposeSettingsMaxBytes {
		return nil, fmt.Errorf("skipped Compose settings report exceeds 1 MB")
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
