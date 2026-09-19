//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows/svc"
)

// configureSshdTrustCA installs the CA key + TrustedUserCAKeys into the Windows
// OpenSSH config, validates with `sshd -t`, reverts on failure, then restarts sshd.
func configureSshdTrustCA(caPub string) error {
	if caPub == "" {
		return fmt.Errorf("empty CA key")
	}
	programData := os.Getenv("ProgramData")
	if programData == "" {
		programData = `C:\ProgramData`
	}
	sshDir := filepath.Join(programData, "ssh")
	caFile := filepath.Join(sshDir, "cerebro_ca.pub")
	sshdConfig := filepath.Join(sshDir, "sshd_config")
	const trustLine = `TrustedUserCAKeys __PROGRAMDATA__\ssh\cerebro_ca.pub`

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
	if bin := windowsSshdPath(); bin != "" {
		if out, err := exec.Command(bin, "-t").CombinedOutput(); err != nil {
			_ = os.WriteFile(sshdConfig, backup, 0o644) // revert
			return fmt.Errorf("sshd config invalid, reverted: %v: %s", err, string(out))
		}
	}
	_ = exec.Command("powershell", "-NoProfile", "-Command", "Restart-Service", "sshd").Run()
	return nil
}

func windowsSshdPath() string {
	for _, p := range []string{
		filepath.Join(os.Getenv("SystemRoot"), "System32", "OpenSSH", "sshd.exe"),
		`C:\Program Files\OpenSSH\sshd.exe`,
	} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	if p, err := exec.LookPath("sshd"); err == nil {
		return p
	}
	return ""
}

const serviceName = "CerebroAgent"

type serviceHandler struct{}

// Execute is the Windows Service Control Manager entry point. It runs agentMain
// in a goroutine and stops it (closes `stop`) when the SCM sends Stop/Shutdown.
func (serviceHandler) Execute(_ []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown
	s <- svc.Status{State: svc.StartPending}

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		agentMain(stop)
		close(done)
	}()

	s <- svc.Status{State: svc.Running, Accepts: accepted}
	for {
		select {
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				s <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				close(stop)
				s <- svc.Status{State: svc.StopPending}
				return false, 0
			}
		case <-done:
			return false, 0
		}
	}
}

// runAgent runs under the SCM when launched as a service, and in the foreground
// otherwise (manual testing).
func runAgent() {
	isService, err := svc.IsWindowsService()
	if err == nil && isService {
		if err := svc.Run(serviceName, serviceHandler{}); err != nil {
			log.Printf("service run failed: %v", err)
		}
		return
	}
	agentMain(make(chan struct{}))
}

// selfUninstall stops + deletes the Windows service and removes the agent's
// install directory, then exits. The removal runs in a detached PowerShell so it
// outlives this process.
func selfUninstall() {
	exe, _ := os.Executable()
	dir := filepath.Dir(exe)
	ps := "Start-Sleep -Seconds 2; " +
		"sc.exe stop " + serviceName + "; " +
		"sc.exe delete " + serviceName + "; " +
		"Remove-Item -Recurse -Force '" + dir + "'"
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", ps)
	// DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP so it survives our exit.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200}
	_ = cmd.Start()
	os.Exit(0)
}

// doSelfUpdate downloads the new binary, moves the running exe aside (allowed on
// Windows), swaps the new one in, and exits non-zero so the service's failure
// action restarts it on the new binary.
func doSelfUpdate(cfg config) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	tmp := exe + ".new"
	if err := downloadAgentBinary(cfg, tmp); err != nil {
		return err
	}
	old := exe + ".old"
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, exe); err != nil {
		_ = os.Rename(old, exe) // roll back
		return err
	}
	log.Print("self-update applied; restarting service")
	os.Exit(1)
	return nil
}
