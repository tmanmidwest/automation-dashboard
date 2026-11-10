//go:build linux

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Linux: whichever package manager the distro uses. apt covers Debian, Ubuntu,
// Raspberry Pi OS and Proxmox VE (which must use dist-upgrade).

type linuxUpdater struct{}

func newOSUpdater() osUpdater { return linuxUpdater{} }

var aptEnv = []string{"DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=a", "APT_LISTCHANGES_FRONTEND=none", "LC_ALL=C"}

// Keep existing config files on upgrade, and wait (rather than fail) when
// unattended-upgrades or another apt is holding the lock.
var aptOpts = []string{"-q", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", "-o", "DPkg::Lock::Timeout=600"}

func linuxManager() string {
	for _, m := range []string{"apt-get", "dnf", "yum", "zypper", "pacman", "apk"} {
		if _, err := exec.LookPath(m); err == nil {
			return m
		}
	}
	return ""
}

func isProxmox() bool {
	return fileExists("/usr/bin/pveversion") || fileExists("/etc/pve/.version")
}

func (linuxUpdater) check(ctx context.Context) updatesReport {
	mgr := linuxManager()
	rep := updatesReport{Manager: strings.TrimSuffix(mgr, "-get"), Supported: mgr != "", CanInstall: mgr != "", SecurityKnown: true}
	if mgr == "" {
		rep.Error = "No supported package manager found (apt, dnf, yum, zypper, pacman or apk)."
		return rep
	}
	switch mgr {
	case "apt-get":
		rep.Proxmox = isProxmox()
		if out, code, err := runOut(ctx, aptEnv, "apt-get", append(aptOpts, "update")...); err != nil || code != 0 {
			rep.Note = "Couldn't refresh the package lists, so this may be out of date: " + lastLines(out, 2)
		}
		out, code, err := runOut(ctx, aptEnv, "apt-get", "-s", "-q", "-o", "Debug::NoLocking=1", "dist-upgrade")
		if err != nil || code != 0 {
			rep.Error = "apt-get couldn't work out the upgrade: " + lastLines(out, 3)
			break
		}
		rep.Packages = parseAptSim(out)
	case "dnf", "yum":
		out, code, err := runOut(ctx, nil, mgr, "-q", "check-update")
		if err != nil || (code != 0 && code != 100) {
			rep.Error = mgr + " check-update failed: " + lastLines(out, 3)
			break
		}
		rep.Packages = parseDnfCheck(out)
		args := []string{"-q", "updateinfo", "list", "--security"}
		if mgr == "yum" {
			args = []string{"-q", "updateinfo", "list", "security"}
		}
		if sout, scode, serr := runOut(ctx, nil, mgr, args...); serr == nil && scode == 0 {
			sec := parseDnfSecurity(sout)
			for i := range rep.Packages {
				if sev, ok := sec[rep.Packages[i].Name]; ok {
					rep.Packages[i].Security = true
					rep.Packages[i].Severity = sev
				}
			}
		} else {
			rep.SecurityKnown = false
			rep.Note = "This system doesn't publish security advisories, so security updates aren't marked."
		}
	case "zypper":
		if out, code, err := runOut(ctx, nil, "zypper", "--non-interactive", "--quiet", "refresh"); err != nil || code != 0 {
			rep.Note = "Couldn't refresh the repositories, so this may be out of date: " + lastLines(out, 2)
		}
		out, code, err := runOut(ctx, nil, "zypper", "--non-interactive", "--quiet", "list-updates")
		if err != nil || code != 0 {
			rep.Error = "zypper list-updates failed: " + lastLines(out, 3)
			break
		}
		rep.Packages = parseZypperList(out)
		if pout, pcode, perr := runOut(ctx, nil, "zypper", "--non-interactive", "--quiet", "list-patches", "--category", "security"); perr == nil && (pcode == 0 || pcode == 100) {
			patches := parseZypperPatches(pout)
			rep.Packages = append(patches, rep.Packages...)
			rep.Security = len(patches)
		}
	case "pacman":
		rep.SecurityKnown = false
		if _, err := exec.LookPath("checkupdates"); err != nil {
			rep.Note = "Install pacman-contrib so Cerebro can list pending updates without touching the package database."
			break
		}
		out, code, err := runOut(ctx, nil, "checkupdates")
		if err != nil || (code != 0 && code != 2) {
			rep.Error = "checkupdates failed: " + lastLines(out, 3)
			break
		}
		rep.Packages = parseCheckupdates(out)
	case "apk":
		rep.SecurityKnown = false
		if out, code, err := runOut(ctx, nil, "apk", "update", "-q"); err != nil || code != 0 {
			rep.Note = "Couldn't refresh the package index, so this may be out of date: " + lastLines(out, 2)
		}
		out, code, err := runOut(ctx, nil, "apk", "-q", "version", "-l", "<")
		if err != nil || code != 0 {
			rep.Error = "apk version failed: " + lastLines(out, 3)
			break
		}
		rep.Packages = parseApkVersion(out)
	}
	if mgr == "zypper" {
		rep.Total = len(rep.Packages) - rep.Security
	} else {
		rep.Total = len(rep.Packages)
		rep.Security = countSecurity(rep.Packages)
	}
	rep.RebootRequired, rep.RebootReason = linuxRebootRequired(ctx, mgr)
	return rep
}

// linuxRebootRequired: the distro's own flag when it has one, else "a newer kernel
// is installed than the one running".
func linuxRebootRequired(ctx context.Context, mgr string) (bool, string) {
	if fileExists("/var/run/reboot-required") || fileExists("/run/reboot-required") {
		reason := "Updates asked for a restart"
		if b, err := os.ReadFile("/var/run/reboot-required.pkgs"); err == nil {
			pk := strings.Fields(string(b))
			if len(pk) > 0 {
				if len(pk) > 4 {
					pk = append(pk[:4], fmt.Sprintf("+%d more", len(pk)-4))
				}
				reason += " (" + strings.Join(pk, ", ") + ")"
			}
		}
		return true, reason
	}
	switch mgr {
	case "dnf", "yum":
		if _, err := exec.LookPath("needs-restarting"); err == nil || mgr == "dnf" {
			args := []string{"needs-restarting", "-r"}
			name := mgr
			if mgr == "yum" {
				name, args = "needs-restarting", []string{"-r"}
			}
			if out, code, err := runOut(ctx, nil, name, args...); err == nil && code == 1 && strings.Contains(strings.ToLower(out), "reboot") {
				return true, "Core libraries or the kernel were updated"
			}
		}
	case "zypper":
		if _, code, err := runOut(ctx, nil, "zypper", "needs-rebooting"); err == nil && code == 102 {
			return true, "Core libraries or the kernel were updated"
		}
	}
	// Newer kernel on disk than the one running.
	running := ""
	if b, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		running = strings.TrimSpace(string(b))
	}
	files, _ := filepath.Glob("/boot/vmlinuz-*")
	var vers []string
	found := false
	for _, f := range files {
		v := strings.TrimPrefix(filepath.Base(f), "vmlinuz-")
		if strings.Contains(v, "rescue") {
			continue
		}
		vers = append(vers, v)
		if v == running {
			found = true
		}
	}
	// Only judge when the running kernel is one of the installed ones (Pi firmware
	// kernels, containers and custom kernels don't show up there).
	if found {
		if newest := newestKernel(vers); newest != "" && newest != running && naturalLess(running, newest) {
			return true, fmt.Sprintf("Kernel %s is installed; %s is running", newest, running)
		}
	}
	return false, ""
}

func (linuxUpdater) install(ctx context.Context, scope string, logf func(string)) (int, error) {
	mgr := linuxManager()
	switch mgr {
	case "apt-get":
		if err := runStream(ctx, aptEnv, logf, "apt-get", append(aptOpts, "update")...); err != nil {
			logf("Package lists didn't refresh; carrying on with what's cached.")
		}
		sim, _, _ := runOut(ctx, aptEnv, "apt-get", "-s", "-q", "-o", "Debug::NoLocking=1", "dist-upgrade")
		pending := parseAptSim(sim)
		if scope == "security" {
			var names []string
			for _, p := range pending {
				if p.Security && p.Current != "" { // only upgrade what's installed
					names = append(names, p.Name)
				}
			}
			if len(names) == 0 {
				logf("No security updates are waiting.")
				return 0, nil
			}
			logf(fmt.Sprintf("Upgrading %d package(s) with security fixes.", len(names)))
			args := append(append([]string{}, aptOpts...), "-y", "install", "--only-upgrade")
			return len(names), runStream(ctx, aptEnv, logf, "apt-get", append(args, names...)...)
		}
		if len(pending) == 0 {
			logf("Everything is already up to date.")
			return 0, nil
		}
		args := append(append([]string{}, aptOpts...), "-y")
		if isProxmox() {
			logf("Proxmox VE: using dist-upgrade, as Proxmox requires.")
			args = append(args, "dist-upgrade")
		} else {
			args = append(args, "--with-new-pkgs", "upgrade")
		}
		return len(pending), runStream(ctx, aptEnv, logf, "apt-get", args...)
	case "dnf":
		if scope == "security" {
			return -1, runStream(ctx, nil, logf, "dnf", "-y", "upgrade", "--security")
		}
		return -1, runStream(ctx, nil, logf, "dnf", "-y", "upgrade")
	case "yum":
		if scope == "security" {
			return -1, runStream(ctx, nil, logf, "yum", "-y", "update", "--security")
		}
		return -1, runStream(ctx, nil, logf, "yum", "-y", "update")
	case "zypper":
		if scope == "security" {
			err := runStream(ctx, nil, logf, "zypper", "--non-interactive", "patch", "--category", "security")
			// 102/103: installed, restart needed / package manager updated itself — both fine.
			if c := exitCodeOf(err); c == 102 || c == 103 {
				return -1, nil
			}
			return -1, err
		}
		err := runStream(ctx, nil, logf, "zypper", "--non-interactive", "update")
		if c := exitCodeOf(err); c == 102 || c == 103 {
			return -1, nil
		}
		return -1, err
	case "pacman":
		if scope == "security" {
			return 0, &cmdError{msg: "Arch doesn't mark security updates. Choose \"All updates\" for this machine.", code: -1}
		}
		return -1, runStream(ctx, nil, logf, "pacman", "-Syu", "--noconfirm")
	case "apk":
		if scope == "security" {
			return 0, &cmdError{msg: "Alpine doesn't mark security updates. Choose \"All updates\" for this machine.", code: -1}
		}
		if err := runStream(ctx, nil, logf, "apk", "update"); err != nil {
			return -1, err
		}
		return -1, runStream(ctx, nil, logf, "apk", "upgrade")
	}
	return 0, &cmdError{msg: "No supported package manager found.", code: -1}
}

func (linuxUpdater) reboot() error {
	if _, err := exec.LookPath("shutdown"); err == nil {
		out, err := exec.Command("shutdown", "-r", "+1", "Cerebro: restarting to finish updates").CombinedOutput()
		if err == nil {
			return nil
		}
		// busybox shutdown doesn't take +1; fall through.
		_ = out
	}
	if _, err := exec.LookPath("systemctl"); err == nil {
		// systemd-run a delayed reboot so this agent can report first.
		if err := exec.Command("systemd-run", "--on-active=60", "--timer-property=AccuracySec=1s", "systemctl", "reboot").Run(); err == nil {
			return nil
		}
	}
	if _, err := exec.LookPath("reboot"); err == nil {
		return exec.Command("reboot", "-d", "60").Start()
	}
	return fmt.Errorf("no shutdown, systemctl or reboot command found")
}
