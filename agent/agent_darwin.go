//go:build darwin

package main

import (
	"os"
	"os/exec"
	"syscall"
)

const launchdPlist = "/Library/LaunchDaemons/com.cerebro.agent.plist"

// selfUninstall unloads the launchd daemon and removes the agent's files, then
// exits. The removal runs in a new session (setsid) so it survives launchd
// killing our own job. Runs as root (LaunchDaemons run as root).
func selfUninstall() {
	exe, _ := os.Executable()
	script := "sleep 1; " +
		"launchctl bootout system " + launchdPlist + " 2>/dev/null || launchctl unload " + launchdPlist + " 2>/dev/null; " +
		"rm -f " + launchdPlist + " '" + exe + "'; " +
		"rm -rf /etc/cerebro-agent"
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} // detach so it outlives us
	_ = cmd.Start()
	os.Exit(0)
}
