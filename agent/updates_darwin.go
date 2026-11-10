//go:build darwin

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/shirou/gopsutil/v4/host"
)

// macOS: softwareupdate. Apple silicon Macs need an owner's password to install
// macOS itself, so those are listed but marked "needs someone at the Mac".

type darwinUpdater struct{}

func newOSUpdater() osUpdater { return darwinUpdater{} }

// macOS has no "restart pending" flag; we remember the boot we installed a
// restart-requiring update in, and it's pending until the Mac boots again.
func macPendingFile() string {
	if updates != nil && updates.stateDir != "" {
		return filepath.Join(updates.stateDir, "updates-restart-pending")
	}
	return ""
}

func macBootTime() string {
	bt, err := host.BootTime()
	if err != nil {
		return ""
	}
	return strconv.FormatUint(bt, 10)
}

func (darwinUpdater) check(ctx context.Context) updatesReport {
	rep := updatesReport{Manager: "softwareupdate", Supported: true, CanInstall: true, SecurityKnown: true}
	out, code, err := runOut(ctx, nil, "softwareupdate", "--list")
	if err != nil || (code != 0 && !strings.Contains(out, "No new software available")) {
		rep.Error = "softwareupdate --list failed: " + lastLines(out, 3)
	} else {
		rep.Packages = parseSoftwareUpdate(out, runtime.GOARCH == "arm64")
	}
	rep.Total = len(rep.Packages)
	rep.Security = countSecurity(rep.Packages)
	for _, p := range rep.Packages {
		if p.NeedsUser {
			rep.Note = "macOS updates on Apple silicon need someone at the Mac (System Settings → General → Software Update)."
			break
		}
	}
	if f := macPendingFile(); f != "" {
		if b, err := os.ReadFile(f); err == nil {
			if strings.TrimSpace(string(b)) == macBootTime() {
				rep.RebootRequired = true
				rep.RebootReason = "An installed update needs a restart"
			} else {
				_ = os.Remove(f)
			}
		}
	}
	return rep
}

func (darwinUpdater) install(ctx context.Context, scope string, logf func(string)) (int, error) {
	out, _, err := runOut(ctx, nil, "softwareupdate", "--list")
	if err != nil {
		return -1, &cmdError{msg: "softwareupdate --list failed: " + err.Error(), code: -1}
	}
	var labels []string
	restart := false
	for _, p := range parseSoftwareUpdate(out, runtime.GOARCH == "arm64") {
		if scope == "security" && !p.Security {
			continue
		}
		if p.NeedsUser {
			logf("Needs someone at the Mac: " + p.Source)
			continue
		}
		labels = append(labels, p.Name)
		restart = restart || p.Restart
	}
	if len(labels) == 0 {
		logf("Nothing that can be installed unattended.")
		return 0, nil
	}
	args := append([]string{"--install", "--agree-to-license"}, labels...)
	if err := runStream(ctx, nil, logf, "softwareupdate", args...); err != nil {
		return -1, err
	}
	if restart {
		if f := macPendingFile(); f != "" {
			_ = os.WriteFile(f, []byte(macBootTime()), 0o600)
		}
	}
	return len(labels), nil
}

func (darwinUpdater) reboot() error {
	return exec.Command("shutdown", "-r", "+1").Run()
}
