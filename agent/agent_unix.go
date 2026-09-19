//go:build !windows

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// configureSshdTrustCA installs the CA public key and a TrustedUserCAKeys line in
// sshd_config, validating with `sshd -t` before reloading — and reverting the
// config on validation failure so a bad edit can never lock sshd. The agent runs
// as root, so it can write /etc/ssh and reload the daemon.
func configureSshdTrustCA(caPub string) error {
	if caPub == "" {
		return fmt.Errorf("empty CA key")
	}
	const caFile = "/etc/ssh/cerebro_ca.pub"
	const sshdConfig = "/etc/ssh/sshd_config"
	const trustLine = "TrustedUserCAKeys " + caFile

	if err := os.WriteFile(caFile, []byte(caPub+"\n"), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", caFile, err)
	}
	backup, err := os.ReadFile(sshdConfig)
	if err != nil {
		return fmt.Errorf("read %s: %w", sshdConfig, err)
	}
	if _, err := ensureLineInFile(sshdConfig, trustLine); err != nil {
		return fmt.Errorf("edit %s: %w", sshdConfig, err)
	}
	if err := validateSshd(); err != nil {
		_ = os.WriteFile(sshdConfig, backup, 0o644) // revert — never leave sshd broken
		return fmt.Errorf("sshd config invalid, reverted: %w", err)
	}
	reloadSshd()
	return nil
}

func validateSshd() error {
	bin := sshdPath()
	if bin == "" {
		return nil // can't validate; we only appended a standard directive
	}
	if out, err := exec.Command(bin, "-t").CombinedOutput(); err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func sshdPath() string {
	for _, p := range []string{"/usr/sbin/sshd", "/sbin/sshd", "/usr/local/sbin/sshd"} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	if p, err := exec.LookPath("sshd"); err == nil {
		return p
	}
	return ""
}

func reloadSshd() {
	if runtime.GOOS == "darwin" {
		return // macOS Remote Login re-reads config on each new connection
	}
	for _, args := range [][]string{
		{"systemctl", "reload", "ssh"},
		{"systemctl", "reload", "sshd"},
		{"service", "ssh", "reload"},
		{"service", "sshd", "reload"},
	} {
		if bin, err := exec.LookPath(args[0]); err == nil {
			if exec.Command(bin, args[1:]...).Run() == nil {
				return
			}
		}
	}
}

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
