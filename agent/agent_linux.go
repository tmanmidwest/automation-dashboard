//go:build linux

package main

import (
	"log"
	"os"
	"os/exec"
	"syscall"
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
		"systemctl stop " + svc + " 2>/dev/null; " +
		"systemctl disable " + svc + " 2>/dev/null; " +
		"rm -f /etc/systemd/system/" + svc + ".service " +
		"/etc/systemd/system/multi-user.target.wants/" + svc + ".service '" + exe + "'; " +
		"rm -rf " + cfgDir + " /var/lib/" + svc + "; " +
		"systemctl daemon-reload 2>/dev/null; " +
		"systemctl reset-failed " + svc + " 2>/dev/null"

	// Prefer systemd-run: the remover runs in its own transient unit/cgroup, so
	// stopping our own service doesn't also kill the remover mid-way (which would
	// leave the unit + binary behind — the classic "it said removed but it's still
	// there" bug). Fall back to a detached session only if systemd-run is missing.
	if _, err := exec.LookPath("systemd-run"); err == nil {
		if err := exec.Command("systemd-run", "--collect", "--unit="+svc+"-uninstall", "/bin/sh", "-c", script).Start(); err == nil {
			log.Print("uninstall scheduled via systemd-run; exiting")
			os.Exit(0)
		} else {
			log.Printf("systemd-run failed (%v); falling back to a detached remover", err)
		}
	} else {
		log.Print("systemd-run not found; using a detached remover (best-effort)")
	}

	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} // detach so it outlives us
	if err := cmd.Start(); err != nil {
		log.Printf("uninstall remover failed to start: %v — manual cleanup may be needed", err)
	}
	os.Exit(0)
}
