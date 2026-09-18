//go:build !windows

package main

import (
	"log"
	"os"
)

// runAgent runs the reconnect loop in the foreground. systemd (Linux) / launchd
// (macOS) supervises the process and delivers SIGTERM to stop it. selfUninstall
// is OS-specific (agent_linux.go / agent_darwin.go).
func runAgent() {
	agentMain(make(chan struct{}))
}

// doSelfUpdate downloads the new binary next to the current one and renames it
// into place (atomic on the same filesystem), then exits so systemd
// (Restart=always) relaunches on the new binary.
func doSelfUpdate(cfg config) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	tmp := exe + ".new"
	if err := downloadAgentBinary(cfg, tmp); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o755); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, exe); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	log.Print("self-update applied; restarting")
	os.Exit(0)
	return nil
}
