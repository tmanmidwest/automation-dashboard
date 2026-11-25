//go:build linux

package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// apt / dpkg lock holders. apt takes POSIX (fcntl) locks on these files, so the
// holder's pid is in /proc/locks. A holder that has been running for a long time
// is almost always stuck (a package script waiting on something that never comes),
// and every later install would just sit behind it for DPkg::Lock::Timeout and
// fail with "exit 100". So the agent names it, fails fast, and Repair can stop it.

var aptLockFiles = []string{
	"/var/lib/dpkg/lock-frontend",
	"/var/lib/dpkg/lock",
	"/var/lib/apt/lists/lock",
	"/var/cache/apt/archives/lock",
}

const (
	// An install fails at once (instead of waiting) when apt has been busy this long.
	aptStuckAfter = 30 * time.Minute
	// Repair stops a lock holder only once it has been running at least this long.
	aptRepairMinAge = 10 * time.Minute
)

type lockHolder struct {
	PID     int
	Comm    string
	Command string
	Running time.Duration // 0 when unknown
	Lock    string
}

func (h lockHolder) describe() string {
	s := fmt.Sprintf("PID %d (%s)", h.PID, h.Command)
	if h.Running > 0 {
		s += ", running for " + fmtDuration(h.Running)
	}
	return s
}

// aptLockHolders lists the processes holding any apt/dpkg lock, one per pid.
func aptLockHolders() []lockHolder { return lockHoldersOf(aptLockFiles) }

func lockHoldersOf(files []string) []lockHolder {
	inodes := map[uint64]string{}
	for _, f := range files {
		var st syscall.Stat_t
		if syscall.Stat(f, &st) == nil {
			inodes[st.Ino] = f
		}
	}
	if len(inodes) == 0 {
		return nil
	}
	b, err := os.ReadFile("/proc/locks")
	if err != nil {
		return nil
	}
	var out []lockHolder
	seen := map[int]bool{}
	for _, pl := range parseProcLocks(string(b)) {
		lock, ok := inodes[pl.inode]
		if !ok || pl.pid <= 0 || seen[pl.pid] {
			continue
		}
		seen[pl.pid] = true
		if isOwnChild(pl.pid) {
			continue // our own install
		}
		h := lockHolder{PID: pl.pid, Lock: lock}
		h.Comm, h.Command, h.Running = procInfo(pl.pid)
		if h.Comm == "" {
			continue // gone already
		}
		out = append(out, h)
	}
	return out
}

type procLock struct {
	pid   int
	inode uint64
}

// parseProcLocks reads /proc/locks lines such as
//
//	3: POSIX  ADVISORY  WRITE 827701 fd:00:1835030 0 EOF
//
// Waiters ("3: -> POSIX ...") and OFD locks (pid -1) are skipped.
func parseProcLocks(s string) []procLock {
	var out []procLock
	sc := bufio.NewScanner(strings.NewReader(s))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 6 || f[1] == "->" {
			continue
		}
		pid, err := strconv.Atoi(f[4])
		if err != nil || pid <= 0 {
			continue
		}
		dev := strings.Split(f[5], ":")
		if len(dev) != 3 {
			continue
		}
		ino, err := strconv.ParseUint(dev[2], 10, 64)
		if err != nil {
			continue
		}
		out = append(out, procLock{pid: pid, inode: ino})
	}
	return out
}

// procInfo: short name, command line and how long the process has been running.
func procInfo(pid int) (comm, cmdline string, running time.Duration) {
	dir := filepath.Join("/proc", strconv.Itoa(pid))
	cb, err := os.ReadFile(filepath.Join(dir, "comm"))
	if err != nil {
		return "", "", 0
	}
	comm = strings.TrimSpace(string(cb))
	if lb, err := os.ReadFile(filepath.Join(dir, "cmdline")); err == nil {
		cmdline = strings.TrimSpace(strings.ReplaceAll(string(lb), "\x00", " "))
	}
	if cmdline == "" {
		cmdline = comm
	}
	if len(cmdline) > 160 {
		cmdline = cmdline[:160] + "…"
	}
	if sb, err := os.ReadFile(filepath.Join(dir, "stat")); err == nil {
		if ticks, ok := parseStatStartTicks(string(sb)); ok {
			if up := uptimeSeconds(); up > 0 {
				started := float64(ticks) / 100 // USER_HZ is 100 on Linux
				if d := up - started; d > 0 {
					running = time.Duration(d * float64(time.Second))
				}
			}
		}
	}
	return comm, cmdline, running
}

// parseStatStartTicks: field 22 (starttime) of /proc/<pid>/stat. The command name
// (field 2) can hold spaces and parentheses, so count from the last ')'.
func parseStatStartTicks(s string) (uint64, bool) {
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return 0, false
	}
	f := strings.Fields(s[i+1:])
	// f[0] is field 3 (state); starttime is field 22 → f[19].
	if len(f) < 20 {
		return 0, false
	}
	v, err := strconv.ParseUint(f[19], 10, 64)
	return v, err == nil
}

func uptimeSeconds() float64 {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return v
}

// isAptProcess: only package-manager processes are ever stopped by Repair.
func isAptProcess(h lockHolder) bool {
	switch h.Comm {
	case "apt", "apt-get", "aptitude", "dpkg", "unattended-upgr", "unattended-upgrade":
		return true
	}
	return strings.Contains(h.Command, "unattended-upgrade")
}

func stuckHolder(hs []lockHolder) *lockHolder {
	for i := range hs {
		if hs[i].Running >= aptStuckAfter {
			return &hs[i]
		}
	}
	return nil
}

// dpkgInterrupted: dpkg left work unfinished (its journal in /var/lib/dpkg/updates
// isn't empty), which `dpkg --configure -a` finishes.
func dpkgInterrupted() bool {
	ents, err := os.ReadDir("/var/lib/dpkg/updates")
	if err != nil {
		return false
	}
	for _, e := range ents {
		if !e.IsDir() {
			return true
		}
	}
	return false
}

// aptHealthNote is shown on Health when apt needs Repair, "" otherwise.
func aptHealthNote() string {
	if h := stuckHolder(aptLockHolders()); h != nil {
		return fmt.Sprintf("apt looks stuck: %s holds the package lock, so installs can't run. Use Repair to stop it and finish any half-done package setup.", h.describe())
	}
	if dpkgInterrupted() {
		return "A package install was interrupted and left unfinished. Use Repair to finish it (dpkg --configure -a)."
	}
	return ""
}

// descendants: every process whose parent chain leads to pid.
func descendants(pid int) []int {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	parent := map[int]int{}
	for _, e := range ents {
		p, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		b, err := os.ReadFile(filepath.Join("/proc", e.Name(), "stat"))
		if err != nil {
			continue
		}
		s := string(b)
		i := strings.LastIndexByte(s, ')')
		if i < 0 {
			continue
		}
		f := strings.Fields(s[i+1:])
		if len(f) < 2 {
			continue
		}
		if pp, err := strconv.Atoi(f[1]); err == nil {
			parent[p] = pp
		}
	}
	var out []int
	for p := range parent {
		for q, n := parent[p], 0; q > 1 && n < 64; q, n = parent[q], n+1 {
			if q == pid {
				out = append(out, p)
				break
			}
		}
	}
	return out
}

func ppidOf(pid int) int {
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0
	}
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return 0
	}
	f := strings.Fields(s[i+1:])
	if len(f) < 2 {
		return 0
	}
	pp, _ := strconv.Atoi(f[1])
	return pp
}

// isOwnChild: pid was started by this agent (an install it's running).
func isOwnChild(pid int) bool {
	me := os.Getpid()
	for q, n := ppidOf(pid), 0; q > 1 && n < 64; q, n = ppidOf(q), n+1 {
		if q == me {
			return true
		}
	}
	return false
}

// alive: the process exists and isn't a zombie waiting for its parent to reap it.
func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return false
	}
	s := string(b)
	if i := strings.LastIndexByte(s, ')'); i >= 0 {
		if f := strings.Fields(s[i+1:]); len(f) > 0 && f[0] == "Z" {
			return false
		}
	}
	return true
}

// stopProcessTree sends SIGTERM to pid and its children, waits up to grace, then
// SIGKILLs whatever is left. Returns true when everything is gone.
func stopProcessTree(pid int, grace time.Duration, logf func(string)) bool {
	tree := append(descendants(pid), pid)
	for _, p := range tree {
		_ = syscall.Kill(p, syscall.SIGTERM)
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		left := false
		for _, p := range tree {
			if alive(p) {
				left = true
				break
			}
		}
		if !left {
			return true
		}
		time.Sleep(500 * time.Millisecond)
	}
	for _, p := range tree {
		if alive(p) {
			logf(fmt.Sprintf("PID %d didn't stop; forcing it.", p))
			_ = syscall.Kill(p, syscall.SIGKILL)
		}
	}
	time.Sleep(time.Second)
	return !alive(pid)
}

// repair: stop a stuck apt/dpkg that holds the lock, then finish what dpkg left
// half-done. Fixed commands only; refuses when apt is genuinely working.
func (linuxUpdater) repair(ctx context.Context, logf func(string)) error {
	if linuxManager() != "apt-get" {
		return &cmdError{msg: "Repair is for apt machines (Debian, Ubuntu, Raspberry Pi OS, Proxmox).", code: -1}
	}
	holders := aptLockHolders()
	if len(holders) == 0 {
		logf("Nothing is holding the apt/dpkg lock.")
	}
	for _, h := range holders {
		logf(fmt.Sprintf("%s holds %s.", h.describe(), h.Lock))
		if !isAptProcess(h) {
			return &cmdError{msg: fmt.Sprintf("The package lock is held by %s, which isn't apt or dpkg, so Repair left it alone.", h.describe()), code: -1}
		}
		if h.Running > 0 && h.Running < aptRepairMinAge {
			return &cmdError{msg: fmt.Sprintf("apt is working right now (%s). Let it finish, or run Repair again if it's still going after %s.", h.describe(), fmtDuration(aptRepairMinAge)), code: -1}
		}
	}
	for _, h := range holders {
		logf(fmt.Sprintf("Stopping PID %d and its child processes…", h.PID))
		if !stopProcessTree(h.PID, 30*time.Second, logf) {
			return &cmdError{msg: fmt.Sprintf("PID %d wouldn't stop.", h.PID), code: -1}
		}
		logf(fmt.Sprintf("PID %d stopped.", h.PID))
	}
	// Give the kernel a moment to drop the locks.
	for i := 0; i < 20 && len(aptLockHolders()) > 0; i++ {
		time.Sleep(500 * time.Millisecond)
	}
	if left := aptLockHolders(); len(left) > 0 {
		return &cmdError{msg: fmt.Sprintf("The lock is still held by %s.", left[0].describe()), code: -1}
	}
	logf("Finishing any half-done package setup (dpkg --configure -a)…")
	if err := runStream(ctx, aptEnv, logf, "dpkg", "--force-confdef", "--force-confold", "--configure", "-a"); err != nil {
		return err
	}
	logf("Fixing any broken dependencies (apt-get -f install)…")
	if err := runStream(ctx, aptEnv, logf, "apt-get", append(append([]string{}, aptOpts...), "-y", "-f", "install")...); err != nil {
		return err
	}
	return nil
}

// aptPreflight runs before an install: names whoever holds the lock and fails at
// once when it has been stuck for a long time.
func aptPreflight(logf func(string)) error {
	hs := aptLockHolders()
	if len(hs) == 0 {
		return nil
	}
	if h := stuckHolder(hs); h != nil {
		return &cmdError{msg: fmt.Sprintf("apt has been busy for %s (%s), so it looks stuck and nothing was installed. Use Repair on this machine to stop it, then install again.", fmtDuration(h.Running), h.describe()), code: -1}
	}
	for _, h := range hs {
		logf(fmt.Sprintf("apt is busy: %s. Waiting up to 10 minutes for it to finish.", h.describe()))
	}
	return nil
}

// lockFailure turns apt's exit 100 after the lock wait into a message that names
// who held the lock.
func lockFailure(err error) error {
	if err == nil {
		return nil
	}
	if exitCodeOf(err) != 100 {
		return err
	}
	hs := aptLockHolders()
	if len(hs) == 0 {
		return err
	}
	return &cmdError{msg: fmt.Sprintf("apt was still busy after waiting 10 minutes: %s holds the package lock. If it stays stuck, use Repair on this machine.", hs[0].describe()), code: 100}
}

func fmtDuration(d time.Duration) string {
	d = d.Round(time.Minute)
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	switch {
	case h >= 24:
		return fmt.Sprintf("%dd %dh", h/24, h%24)
	case h > 0:
		return fmt.Sprintf("%dh %dm", h, m)
	case m > 0:
		return fmt.Sprintf("%dm", m)
	}
	return "under a minute"
}
