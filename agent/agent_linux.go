//go:build linux

package main

import (
	"os"
	"os/exec"
)

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
