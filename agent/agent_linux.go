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
	svc := unixServiceName() // "cerebro-agent" or "cerebro-waypoint"
	cfgDir := modeConfigDir()
	script := "sleep 1; " +
		"systemctl disable --now " + svc + " 2>/dev/null; " +
		"rm -f /etc/systemd/system/" + svc + ".service '" + exe + "'; " +
		"rm -rf " + cfgDir + "; " +
		"systemctl daemon-reload 2>/dev/null"
	_ = exec.Command("systemd-run", "--collect", "--unit="+svc+"-uninstall", "/bin/sh", "-c", script).Start()
	os.Exit(0)
}
