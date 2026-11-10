package main

// OS updates (Cerebro Health → Updates, docs/os-updates.md).
//
// The agent finds pending OS/package updates with the machine's own package
// manager (apt, dnf/yum, zypper, pacman, apk, Windows Update, softwareupdate),
// reports them to Cerebro, and — when Cerebro sends a signed command — installs
// them and optionally restarts the machine. Cerebro never sends a command line:
// it sends "install, scope=security|all, reboot=never|if-needed|always", and the
// agent runs its own fixed commands for that (updates_<os>.go).
//
// The box can opt out with CEREBRO_OS_UPDATES in config.env (or the environment):
//   on (default)  check and allow installs
//   report        check and report only; install/restart commands are refused
//   off           don't check at all

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// How often to look for updates (plus on start and when Cerebro asks).
	updatesCheckEvery = 6 * time.Hour
	// First check after the agent starts, so a fresh boot isn't slowed down.
	updatesFirstCheck = 90 * time.Second
	// Package lists can be long (a stale box may have hundreds); cap what's sent.
	updatesMaxPackages    = 400
	updatesCheckTimeout   = 20 * time.Minute
	updatesInstallTimeout = 3 * time.Hour
	// Log lines are batched onto the socket at this cadence while an install runs.
	updatesLogFlush   = time.Second
	updatesLogLineMax = 400
	lastRunFile       = "updates-last-run.json"
)

type pkgUpdate struct {
	Name      string `json:"name"`
	Current   string `json:"current,omitempty"`
	Available string `json:"available,omitempty"`
	Security  bool   `json:"security,omitempty"`
	Severity  string `json:"severity,omitempty"`
	KB        string `json:"kb,omitempty"`
	Source    string `json:"source,omitempty"`
	// Restart: installing this one needs a restart (Windows / macOS report it per update).
	Restart bool `json:"restart,omitempty"`
	// NeedsUser: can't be installed unattended (macOS system updates on Apple silicon).
	NeedsUser bool `json:"needsUser,omitempty"`
}

type updatesRun struct {
	RunID      string `json:"runId"`
	Kind       string `json:"kind"` // install | reboot
	OK         bool   `json:"ok"`
	ExitCode   int    `json:"exitCode"`
	Message    string `json:"message,omitempty"`
	StartedAt  int64  `json:"startedAt"`
	FinishedAt int64  `json:"finishedAt"`
	Rebooting  bool   `json:"rebooting,omitempty"`
	Installed  int    `json:"installed,omitempty"`
}

type updatesReport struct {
	CheckedAt int64       `json:"checkedAt"` // unix ms
	Manager   string      `json:"manager,omitempty"`
	Supported bool        `json:"supported"`
	Error     string      `json:"error,omitempty"`
	Note      string      `json:"note,omitempty"`
	Packages  []pkgUpdate `json:"packages"`
	Total     int         `json:"total"`
	Security  int         `json:"security"`
	// SecurityKnown: the package manager tells security fixes apart (pacman/apk don't).
	SecurityKnown  bool        `json:"securityKnown"`
	RebootRequired bool        `json:"rebootRequired"`
	RebootReason   string      `json:"rebootReason,omitempty"`
	CanInstall     bool        `json:"canInstall"`
	Proxmox        bool        `json:"proxmox,omitempty"`
	Mode           string      `json:"mode"` // on | report | off
	Installing     string      `json:"installing,omitempty"`
	Checking       bool        `json:"checking,omitempty"`
	LastRun        *updatesRun `json:"lastRun,omitempty"`
}

// osUpdater is implemented per OS (updates_linux.go, updates_windows.go, updates_darwin.go).
type osUpdater interface {
	check(ctx context.Context) updatesReport
	// install runs the update; logf receives progress lines. Returns how many were
	// installed when known (-1 when not), and an error when it failed.
	install(ctx context.Context, scope string, logf func(string)) (int, error)
	reboot() error
}

type updater struct {
	mode     string
	stateDir string
	impl     osUpdater

	checkNow chan struct{}
	outbox   chan map[string]any

	mu         sync.Mutex
	last       *updatesReport
	checking   bool
	installing string
	lastRun    *updatesRun
}

var updates *updater

func newUpdater(cfg config) *updater {
	mode := strings.ToLower(strings.TrimSpace(cfg.OSUpdates))
	if mode != "off" && mode != "report" {
		mode = "on"
	}
	u := &updater{
		mode:     mode,
		stateDir: cfg.StateDir,
		impl:     newOSUpdater(),
		checkNow: make(chan struct{}, 1),
		outbox:   make(chan map[string]any, 512),
	}
	u.lastRun = u.loadLastRun()
	return u
}

// busy reports whether an install is running (self-update waits for it).
func (u *updater) busy() bool {
	if u == nil {
		return false
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.installing != ""
}

func (u *updater) emit(frame map[string]any) {
	select {
	case u.outbox <- frame:
	default:
		// Disconnected for a long time and the queue filled: drop. The report and the
		// last run's result are re-sent on reconnect, so nothing important is lost.
	}
}

// onConnect re-sends the current state so Cerebro is up to date after a reconnect
// (or its own restart).
func (u *updater) onConnect() {
	if u == nil || u.mode == "off" {
		return
	}
	u.mu.Lock()
	rep := u.snapshotLocked()
	u.mu.Unlock()
	if rep != nil {
		u.emit(map[string]any{"t": "updates", "report": rep})
	}
}

// snapshotLocked returns the last report with live fields filled in (nil before the first check).
func (u *updater) snapshotLocked() *updatesReport {
	if u.last == nil {
		if u.lastRun == nil && !u.checking {
			return nil
		}
		r := updatesReport{Mode: u.mode, Packages: []pkgUpdate{}}
		u.last = &r
	}
	r := *u.last
	r.Mode = u.mode
	r.Installing = u.installing
	r.Checking = u.checking
	r.LastRun = u.lastRun
	if u.mode != "on" {
		r.CanInstall = false
	}
	return &r
}

func (u *updater) requestCheck() {
	select {
	case u.checkNow <- struct{}{}:
	default:
	}
}

// run is the check loop; never returns.
func (u *updater) run() {
	if u.mode == "off" {
		log.Print("OS update checks are off (CEREBRO_OS_UPDATES=off)")
		return
	}
	timer := time.NewTimer(updatesFirstCheck)
	for {
		select {
		case <-timer.C:
		case <-u.checkNow:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
		u.checkOnce(false)
		timer.Reset(updatesCheckEvery)
	}
}

// checkOnce runs a check and reports it. During an install it only re-sends the
// current state (the install re-checks when it finishes), unless force.
func (u *updater) checkOnce(force bool) *updatesReport {
	u.mu.Lock()
	if (u.installing != "" && !force) || u.checking {
		rep := u.snapshotLocked()
		u.mu.Unlock()
		if rep != nil {
			u.emit(map[string]any{"t": "updates", "report": rep})
		}
		return rep
	}
	u.checking = true
	if rep := u.snapshotLocked(); rep != nil {
		u.emit(map[string]any{"t": "updates", "report": rep}) // shows "checking…"
	}
	u.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), updatesCheckTimeout)
	rep := safeCheck(ctx, u.impl)
	cancel()
	rep.CheckedAt = time.Now().UnixMilli()
	if len(rep.Packages) > updatesMaxPackages {
		// Keep security ones first so they survive the cap.
		sec := make([]pkgUpdate, 0, len(rep.Packages))
		rest := make([]pkgUpdate, 0, len(rep.Packages))
		for _, p := range rep.Packages {
			if p.Security {
				sec = append(sec, p)
			} else {
				rest = append(rest, p)
			}
		}
		rep.Packages = append(sec, rest...)[:updatesMaxPackages]
	}
	if rep.Packages == nil {
		rep.Packages = []pkgUpdate{}
	}

	u.mu.Lock()
	u.checking = false
	u.last = &rep
	out := u.snapshotLocked()
	u.mu.Unlock()
	if rep.Error != "" {
		log.Printf("update check: %s", rep.Error)
	} else {
		log.Printf("update check: %d pending (%d security)%s", rep.Total, rep.Security, map[bool]string{true: ", restart needed", false: ""}[rep.RebootRequired])
	}
	u.emit(map[string]any{"t": "updates", "report": out})
	return out
}

func safeCheck(ctx context.Context, impl osUpdater) (rep updatesReport) {
	defer func() {
		if r := recover(); r != nil {
			rep = updatesReport{Error: fmt.Sprintf("update check crashed: %v", r)}
		}
	}()
	return impl.check(ctx)
}

// install handles a verified install command.
func (u *updater) install(runID, scope, reboot string) {
	started := time.Now()
	fail := func(msg string) {
		u.emit(map[string]any{"t": "updates-result", "result": updatesRun{RunID: runID, Kind: "install", OK: false, ExitCode: -1, Message: msg, StartedAt: started.UnixMilli(), FinishedAt: time.Now().UnixMilli()}})
	}
	if u.mode != "on" {
		fail(fmt.Sprintf("Installs are turned off on this machine (CEREBRO_OS_UPDATES=%s).", u.mode))
		return
	}
	if scope != "security" && scope != "all" {
		fail("Unknown scope.")
		return
	}
	if reboot != "never" && reboot != "if-needed" && reboot != "always" {
		fail("Unknown restart option.")
		return
	}
	u.mu.Lock()
	if u.installing != "" {
		cur := u.installing
		u.mu.Unlock()
		fail(fmt.Sprintf("Another update run (%s) is still going on this machine.", cur))
		return
	}
	if updating.Load() {
		u.mu.Unlock()
		fail("The agent is updating itself right now; try again in a minute.")
		return
	}
	u.installing = runID
	rep := u.snapshotLocked()
	u.mu.Unlock()
	if rep != nil {
		u.emit(map[string]any{"t": "updates", "report": rep})
	}
	log.Printf("installing updates (run %s, scope %s, restart %s)", runID, scope, reboot)

	lw := newRunLog(u, runID)
	lw.line(fmt.Sprintf("Cerebro agent %s: installing %s updates on %s", agentVersion, map[string]string{"security": "security", "all": "all"}[scope], hostname()))
	ctx, cancel := context.WithTimeout(context.Background(), updatesInstallTimeout)
	installed, err := safeInstall(ctx, u.impl, scope, lw.line)
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	cancel()

	res := updatesRun{RunID: runID, Kind: "install", OK: err == nil, StartedAt: started.UnixMilli(), Installed: installed}
	switch {
	case timedOut:
		res.OK = false
		res.ExitCode = -1
		res.Message = fmt.Sprintf("Stopped after %s.", updatesInstallTimeout)
	case err != nil:
		res.ExitCode = exitCodeOf(err)
		res.Message = err.Error()
	default:
		res.Message = "Updates installed."
		if installed == 0 {
			res.Message = "Nothing to install."
		}
	}
	lw.line("Checking what's still pending…")
	lw.flush()

	after := u.checkOnce(true)
	needRestart := after != nil && after.RebootRequired
	if res.OK && (reboot == "always" || (reboot == "if-needed" && needRestart)) {
		res.Rebooting = true
	}
	if res.OK && needRestart && !res.Rebooting {
		res.Message += " A restart is needed to finish."
	}
	if res.Rebooting {
		lw.line("Restarting in about a minute to finish.")
		lw.flush()
	}
	res.FinishedAt = time.Now().UnixMilli()

	u.mu.Lock()
	u.installing = ""
	u.lastRun = &res
	u.saveLastRunLocked()
	final := u.snapshotLocked()
	u.mu.Unlock()
	u.emit(map[string]any{"t": "updates-result", "result": res})
	u.emit(map[string]any{"t": "updates", "report": final})
	log.Printf("update run %s finished: ok=%v %s", runID, res.OK, res.Message)

	if res.Rebooting {
		time.Sleep(3 * time.Second) // let the result reach Cerebro
		if err := u.impl.reboot(); err != nil {
			log.Printf("restart after updates failed: %v", err)
			u.mu.Lock()
			res.Rebooting = false
			res.Message += " The restart didn't start: " + err.Error()
			u.lastRun = &res
			u.saveLastRunLocked()
			u.mu.Unlock()
			u.emit(map[string]any{"t": "updates-result", "result": res})
		}
	}
}

// restart handles a verified restart command.
func (u *updater) restart(runID string) {
	now := time.Now().UnixMilli()
	res := updatesRun{RunID: runID, Kind: "reboot", StartedAt: now}
	if u.mode != "on" {
		res.Message = fmt.Sprintf("Restarts are turned off on this machine (CEREBRO_OS_UPDATES=%s).", u.mode)
	} else if u.busy() {
		res.Message = "An update run is still going; restart after it finishes."
	} else if err := u.impl.reboot(); err != nil {
		res.Message = "Restart failed: " + err.Error()
	} else {
		res.OK = true
		res.Rebooting = true
		res.Message = "Restarting in about a minute."
	}
	res.FinishedAt = time.Now().UnixMilli()
	if !res.OK {
		res.ExitCode = -1
	}
	u.mu.Lock()
	u.lastRun = &res
	u.saveLastRunLocked()
	u.mu.Unlock()
	log.Printf("restart command (run %s): %s", runID, res.Message)
	u.emit(map[string]any{"t": "updates-result", "result": res})
}

func safeInstall(ctx context.Context, impl osUpdater, scope string, logf func(string)) (n int, err error) {
	defer func() {
		if r := recover(); r != nil {
			n, err = -1, fmt.Errorf("install crashed: %v", r)
		}
	}()
	return impl.install(ctx, scope, logf)
}

func (u *updater) loadLastRun() *updatesRun {
	if u.stateDir == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(u.stateDir, lastRunFile))
	if err != nil {
		return nil
	}
	var r updatesRun
	if json.Unmarshal(b, &r) != nil || r.RunID == "" {
		return nil
	}
	return &r
}

func (u *updater) saveLastRunLocked() {
	if u.stateDir == "" || u.lastRun == nil {
		return
	}
	b, _ := json.Marshal(u.lastRun)
	_ = os.WriteFile(filepath.Join(u.stateDir, lastRunFile), b, 0o600)
}

// runLog batches an install's output lines onto the socket.
type runLog struct {
	u     *updater
	runID string
	mu    sync.Mutex
	buf   []string
	last  time.Time
}

func newRunLog(u *updater, runID string) *runLog {
	return &runLog{u: u, runID: runID, last: time.Now()}
}

func (l *runLog) line(s string) {
	s = strings.TrimRight(s, " \t")
	if strings.TrimSpace(s) == "" {
		return
	}
	if len(s) > updatesLogLineMax {
		s = s[:updatesLogLineMax] + "…"
	}
	l.mu.Lock()
	l.buf = append(l.buf, s)
	due := time.Since(l.last) >= updatesLogFlush || len(l.buf) >= 200
	l.mu.Unlock()
	if due {
		l.flush()
	}
}

func (l *runLog) flush() {
	l.mu.Lock()
	lines := l.buf
	l.buf = nil
	l.last = time.Now()
	l.mu.Unlock()
	if len(lines) > 0 {
		l.u.emit(map[string]any{"t": "updates-log", "runId": l.runID, "lines": lines})
	}
}

// --- command helpers ------------------------------------------------------

type cmdError struct {
	msg  string
	code int
}

func (e *cmdError) Error() string { return e.msg }

func exitCodeOf(err error) int {
	var ce *cmdError
	if errors.As(err, &ce) {
		return ce.code
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}

// runOut runs a command and returns its combined output and exit code (-1 when it
// couldn't start). Used for checks.
func runOut(ctx context.Context, env []string, name string, args ...string) (string, int, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if env != nil {
		cmd.Env = append(os.Environ(), env...)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return string(out), ee.ExitCode(), nil
		}
		return string(out), -1, err
	}
	return string(out), 0, nil
}

// runStream runs a command, sending each output line to logf. A non-zero exit
// becomes a *cmdError naming the command.
func runStream(ctx context.Context, env []string, logf func(string), name string, args ...string) error {
	logf("$ " + name + " " + strings.Join(args, " "))
	cmd := exec.CommandContext(ctx, name, args...)
	if env != nil {
		cmd.Env = append(os.Environ(), env...)
	}
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw
	cmd.Stdin = nil
	if err := cmd.Start(); err != nil {
		pw.Close()
		return &cmdError{msg: fmt.Sprintf("%s couldn't start: %v", name, err), code: -1}
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		sc.Split(scanLinesCR)
		for sc.Scan() {
			logf(sc.Text())
		}
		_, _ = io.Copy(io.Discard, pr)
	}()
	err := cmd.Wait()
	pw.Close()
	<-done
	if err != nil {
		code := -1
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		}
		if ctx.Err() != nil {
			return &cmdError{msg: fmt.Sprintf("%s was stopped: %v", name, ctx.Err()), code: code}
		}
		return &cmdError{msg: fmt.Sprintf("%s exited with code %d", name, code), code: code}
	}
	return nil
}

// scanLinesCR splits on \n, \r\n and bare \r (progress bars redraw with \r).
func scanLinesCR(data []byte, atEOF bool) (advance int, token []byte, err error) {
	for i, b := range data {
		if b == '\n' || b == '\r' {
			j := i + 1
			if b == '\r' && j < len(data) && data[j] == '\n' {
				j++
			} else if b == '\r' && j == len(data) && !atEOF {
				return 0, nil, nil // might be \r\n split across reads
			}
			return j, data[:i], nil
		}
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}

// lastLines returns the last n non-empty lines of s, joined — for error messages.
func lastLines(s string, n int) string {
	var keep []string
	for _, l := range strings.Split(strings.TrimSpace(s), "\n") {
		if strings.TrimSpace(l) != "" {
			keep = append(keep, strings.TrimSpace(l))
		}
	}
	if len(keep) > n {
		keep = keep[len(keep)-n:]
	}
	out := strings.Join(keep, " / ")
	if len(out) > 400 {
		out = out[:400] + "…"
	}
	return out
}
