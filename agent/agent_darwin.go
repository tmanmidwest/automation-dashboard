//go:build darwin

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// launchdPlistPath is the daemon plist for this mode ("com.cerebro.agent" or
// "com.cerebro.waypoint"), so an agent and a Waypoint can coexist.
func launchdPlistPath() string { return "/Library/LaunchDaemons/" + launchdLabel() + ".plist" }

// selfUninstall unloads the launchd daemon and removes the agent's files, then
// exits. The removal runs in a new session (setsid) so it survives launchd
// killing our own job. Runs as root (LaunchDaemons run as root).
func selfUninstall() {
	exe, _ := os.Executable()
	plist := launchdPlistPath()
	script := "sleep 1; " +
		"launchctl bootout system " + plist + " 2>/dev/null || launchctl unload " + plist + " 2>/dev/null; " +
		"rm -f " + plist + " '" + exe + "'; " +
		"rm -rf " + modeConfigDir()
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} // detach so it outlives us
	_ = cmd.Start()
	os.Exit(0)
}
