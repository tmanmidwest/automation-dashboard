//go:build !windows

package main

import (
	"log"
	"os"
	"os/exec"
)

// runAgent runs the reconnect loop in the foreground. systemd supervises the
// process and delivers SIGTERM to stop it.
func runAgent() {
	agentMain(make(chan struct{}))
}

// selfUninstall stops + disables the systemd service and removes the agent's
// files, then exits. The removal runs via `systemd-run` so it lives in its own
// cgroup and survives us stopping our own service. Requires root (the installer
// runs the service as root for exactly this reason).
func selfUninstall() {
	exe, _ := os.Executable()
	script := "sleep 1; " +
		"systemctl disable --now cerebro-agent 2>/dev/null; " +
		"rm -f /etc/systemd/system/cerebro-agent.service '" + exe + "'; " +
		"rm -rf /etc/cerebro-agent; " +
		"systemctl daemon-reload 2>/dev/null"
	_ = exec.Command("systemd-run", "--collect", "--unit=cerebro-agent-uninstall", "/bin/sh", "-c", script).Start()
	os.Exit(0)
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
