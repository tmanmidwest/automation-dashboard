//go:build !windows

package main

import (
	"os/exec"
	"syscall"
	"time"
)

// stopTreeOnCancel runs the command in its own process group, and when its context
// ends (timeout) stops the whole group, not just the leader: apt-get's dpkg and
// package scripts would otherwise keep running and hold the dpkg lock. SIGTERM
// first, SIGKILL a minute later for whatever is left.
func stopTreeOnCancel(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		pgid := cmd.Process.Pid
		err := syscall.Kill(-pgid, syscall.SIGTERM)
		go func() {
			time.Sleep(time.Minute)
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}()
		return err
	}
	cmd.WaitDelay = 90 * time.Second
}
