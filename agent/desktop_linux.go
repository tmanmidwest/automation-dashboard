//go:build linux

package main

// Fabric Remote Desktop (Linux): give the box a GUI session the broker can reach, with no
// command line on the box. Two paths, auto-picked:
//
//   P1 — Real logged-in desktop. If someone is logged in at the screen, drive the OS's own
//        remote desktop (gnome-remote-desktop RDP on Wayland/Xorg GNOME) with a one-time
//        credential. This shows the ACTUAL screen — the only option on Wayland.
//   P2 — Bundled virtual desktop. If there's no usable real session (headless servers), or
//        the real path isn't available, launch a self-contained Xvnc + window manager as the
//        box's desktop user on a free display, bound to loopback, with an agent-minted VNC
//        password. A virtual screen, separate from any physical monitor.
//
// P3 polish: each desktop-start is tracked under its session id so desktops are torn down
// per-session (the idle watchdog in main.go forces this on disconnect/idle), and the virtual
// desktop honors a requested resolution.
//
// Both bind to loopback on the agent; only the agent brokers the port over the tunnel. Every
// failure returns a descriptive error that the broker surfaces to the operator.

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	grdRdpPort     = 3389
	defaultWidth   = 1600
	defaultHeight  = 900
	vncColorDepth  = "24"
	minDesktopSide = 640
	maxDesktopSide = 5120
)

// desk is a live remote-desktop session, tracked by the broker's session id so it can be torn
// down individually. A "real" desk is the box's gnome-remote-desktop enablement; a "virtual"
// desk owns the processes it launched.
type desk struct {
	id   string
	kind string // "real" | "virtual"
	port int
	user string
	uid  string
	cmds []*exec.Cmd
	dir  string
}

var desks = struct {
	mu sync.Mutex
	m  map[string]*desk
}{m: map[string]*desk{}}

func registerDesk(d *desk) {
	desks.mu.Lock()
	desks.m[d.id] = d
	desks.mu.Unlock()
}

// startDesktop configures a desktop for remote control and returns what to broker to. It
// prefers the real logged-in session; failing that (headless, non-GNOME, or grd error) it
// falls back to the bundled virtual desktop.
func startDesktop(id, username, password, _ string, width, height int) (desktopResult, error) {
	var realErr error
	if user, uid, sessionType, err := activeGraphicalSession(); err == nil {
		res, rerr := startRealDesktop(id, user, uid, sessionType, username, password)
		if rerr == nil {
			return res, nil
		}
		realErr = rerr
		log.Printf("remote desktop: real-session path failed (%v) — falling back to a bundled virtual desktop", rerr)
	} else {
		realErr = err
	}

	res, verr := startVirtualDesktop(id, width, height)
	if verr != nil {
		if realErr != nil {
			return desktopResult{}, fmt.Errorf("no usable real desktop (%v); virtual desktop fallback also failed: %v", realErr, verr)
		}
		return desktopResult{}, verr
	}
	return res, nil
}

// stopDesktop tears down the desktop(s) for a session id. An empty id or "*" stops all (used
// when the agent's control session drops, or on an explicit broker-wide stop).
func stopDesktop(id string) error {
	desks.mu.Lock()
	var victims []*desk
	for k, d := range desks.m {
		if id == "" || id == "*" || k == id {
			victims = append(victims, d)
			delete(desks.m, k)
		}
	}
	desks.mu.Unlock()
	for _, d := range victims {
		teardownDesk(d)
	}
	return nil
}

func teardownDesk(d *desk) {
	switch d.kind {
	case "real":
		revertGrd(d.user, d.uid)
	case "virtual":
		killAll(d.cmds)
		if d.dir != "" {
			os.RemoveAll(d.dir)
		}
	}
}

// ---------------------------------------------------------------------------
// P1 — real logged-in desktop via gnome-remote-desktop
// ---------------------------------------------------------------------------

func startRealDesktop(id, user, uid, sessionType, username, password string) (desktopResult, error) {
	env := []string{
		"XDG_RUNTIME_DIR=/run/user/" + uid,
		"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/" + uid + "/bus",
	}
	if _, err := runAsUser(user, env, "sh", "-c", "command -v grdctl"); err != nil {
		return desktopResult{}, fmt.Errorf("gnome-remote-desktop (grdctl) is not available for %s's %s session", user, sessionType)
	}

	crt, key, err := ensureTLSCert(uid)
	if err != nil {
		return desktopResult{}, fmt.Errorf("could not prepare a TLS certificate for gnome-remote-desktop: %w", err)
	}

	// Configure + enable RDP. grdctl writes per-user gsettings; the user's session bus is
	// required, which is why every call runs as the user with DBUS/XDG env set.
	steps := [][]string{
		{"grdctl", "rdp", "set-tls-cert", crt},
		{"grdctl", "rdp", "set-tls-key", key},
		{"grdctl", "rdp", "set-credentials", username, password},
		{"grdctl", "rdp", "enable"},
	}
	for _, step := range steps {
		if out, err := runAsUser(user, env, step[0], step[1:]...); err != nil {
			return desktopResult{}, fmt.Errorf("gnome-remote-desktop setup failed at `%s`: %v: %s", strings.Join(step, " "), err, strings.TrimSpace(out))
		}
	}
	// Make sure the user service is actually running (on a fresh enable it may need a kick).
	_, _ = runAsUser(user, env, "systemctl", "--user", "start", "gnome-remote-desktop.service")

	// Give grd a moment to bind the RDP listener before the broker dials it.
	for i := 0; i < 10; i++ {
		if portListening(grdRdpPort) {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if !portListening(grdRdpPort) {
		return desktopResult{}, fmt.Errorf("gnome-remote-desktop was enabled for %s but nothing is listening on 127.0.0.1:%d yet — on some GNOME versions RDP only starts once the user has unlocked the session", user, grdRdpPort)
	}
	registerDesk(&desk{id: id, kind: "real", port: grdRdpPort, user: user, uid: uid})
	return desktopResult{proto: "rdp", port: grdRdpPort, mode: "real"}, nil
}

// revertGrd disables the gnome-remote-desktop RDP enablement for a user (best-effort).
func revertGrd(user, uid string) {
	env := []string{
		"XDG_RUNTIME_DIR=/run/user/" + uid,
		"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/" + uid + "/bus",
	}
	_, _ = runAsUser(user, env, "grdctl", "rdp", "disable")
}

// activeGraphicalSession finds the logged-in user whose session is a graphical (wayland/x11)
// one, via loginctl. Returns the username, uid (string), and session type.
func activeGraphicalSession() (string, string, string, error) {
	out, err := exec.Command("loginctl", "list-sessions", "--no-legend").CombinedOutput()
	if err != nil {
		return "", "", "", fmt.Errorf("loginctl: %v", err)
	}
	type cand struct{ user, uid, typ, state string }
	var best *cand
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		sid := fields[0]
		props, perr := exec.Command("loginctl", "show-session", sid,
			"-p", "Type", "-p", "State", "-p", "Name", "-p", "User").CombinedOutput()
		if perr != nil {
			continue
		}
		m := parseProps(string(props))
		typ := m["Type"]
		if typ != "wayland" && typ != "x11" {
			continue
		}
		c := cand{user: m["Name"], uid: m["User"], typ: typ, state: m["State"]}
		if c.user == "" || c.uid == "" {
			continue
		}
		// Prefer an active session; otherwise take the first graphical one.
		if c.state == "active" {
			return c.user, c.uid, c.typ, nil
		}
		if best == nil {
			cc := c
			best = &cc
		}
	}
	if best != nil {
		return best.user, best.uid, best.typ, nil
	}
	return "", "", "", fmt.Errorf("no wayland/x11 session")
}

func parseProps(s string) map[string]string {
	m := map[string]string{}
	for _, line := range strings.Split(s, "\n") {
		if i := strings.IndexByte(line, '='); i > 0 {
			m[strings.TrimSpace(line[:i])] = strings.TrimSpace(line[i+1:])
		}
	}
	return m
}

// runAsUser runs a command to completion as the given user (we are root) with the supplied
// extra env, using runuser (util-linux, present on Ubuntu, no password needed for root).
func runAsUser(user string, env []string, name string, args ...string) (string, error) {
	full := append([]string{"-u", user, "--", "env"}, env...)
	full = append(full, name)
	full = append(full, args...)
	cmd := exec.Command("runuser", full...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// ensureTLSCert writes a self-signed cert+key gnome-remote-desktop can use, under the user's
// runtime dir (root-created, chowned to the user), and returns their paths.
func ensureTLSCert(uid string) (string, string, error) {
	dir := "/run/user/" + uid
	crtPath := dir + "/cerebro-grd.crt"
	keyPath := dir + "/cerebro-grd.key"
	if fileExists(crtPath) && fileExists(keyPath) {
		return crtPath, keyPath, nil
	}
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return "", "", err
	}
	tmpl := x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(1, 0, 0),
		KeyUsage:     x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return "", "", err
	}
	if err := os.WriteFile(crtPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o640); err != nil {
		return "", "", err
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)}), 0o640); err != nil {
		return "", "", err
	}
	// grd reads these as the user — chown so it can.
	if n, err := strconv.Atoi(uid); err == nil {
		_ = os.Chown(crtPath, n, n)
		_ = os.Chown(keyPath, n, n)
	}
	return crtPath, keyPath, nil
}

// ---------------------------------------------------------------------------
// P2 — bundled virtual desktop (headless fallback)
// ---------------------------------------------------------------------------

// startVirtualDesktop launches a self-contained Xvnc (or Xvfb+x11vnc) + window manager as the
// box's desktop user on a free loopback display, protected by an agent-minted VNC password.
func startVirtualDesktop(id string, width, height int) (desktopResult, error) {
	user, uid, home, err := resolveDesktopUser()
	if err != nil {
		return desktopResult{}, err
	}
	tc, err := desktopToolchain()
	if err != nil {
		return desktopResult{}, err
	}
	display, port, err := freeDisplay()
	if err != nil {
		return desktopResult{}, err
	}
	geometry := fmt.Sprintf("%dx%d", clampSide(width, defaultWidth), clampSide(height, defaultHeight))

	// Per-session scratch dir (password file + server logs), owned by the desktop user.
	dir, err := os.MkdirTemp("", "cerebro-vdesk-")
	if err != nil {
		return desktopResult{}, fmt.Errorf("could not create a work dir for the virtual desktop: %w", err)
	}
	chownTo(dir, uid)

	password := randPassword(8) // classic VNC auth truncates to 8 chars
	passFile := filepath.Join(dir, "passwd")
	if err := tc.writePasswd(passFile, password, uid); err != nil {
		os.RemoveAll(dir)
		return desktopResult{}, fmt.Errorf("could not set the virtual-desktop password: %w", err)
	}

	env := []string{"HOME=" + home, "USER=" + user, "LOGNAME=" + user}
	if tc.binDir != "" {
		env = append(env, "PATH="+tc.binDir+":/usr/local/bin:/usr/bin:/bin")
	}

	var started []*exec.Cmd
	cleanup := func() {
		killAll(started)
		os.RemoveAll(dir)
	}

	srvCmds, err := tc.launchServer(user, env, display, port, passFile, dir, geometry)
	if err != nil {
		cleanup()
		return desktopResult{}, err
	}
	started = append(started, srvCmds...)

	up := false
	for i := 0; i < 20; i++ {
		if portListening(port) {
			up = true
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if !up {
		cleanup()
		return desktopResult{}, fmt.Errorf("the bundled virtual desktop (%s) did not come up on 127.0.0.1:%d — see %s on the host", tc.serverName, port, filepath.Join(dir, "server.log"))
	}

	// Start a window manager / session on that display. A bare screen still works, so a WM
	// failure is non-fatal.
	if wm := tc.launchWM(user, append(env, "DISPLAY=:"+strconv.Itoa(display)), dir); wm != nil {
		started = append(started, wm)
	}

	registerDesk(&desk{id: id, kind: "virtual", port: port, user: user, uid: uid, cmds: started, dir: dir})
	return desktopResult{proto: "vnc", port: port, cred: password, mode: "virtual"}, nil
}

// toolchain is the set of resolved virtual-desktop binaries (from the agent's bundle if
// present, otherwise the host's PATH) plus which VNC server flavor we'll drive.
type toolchain struct {
	binDir     string // bundled dir, prepended to lookups ("" if not bundled)
	serverName string // for operator-facing messages
	xvnc       string // TigerVNC Xvnc (preferred: virtual X server that speaks VNC)
	vncpasswd  string
	x11vnc     string
	xvfb       string
	wm         string // window manager / session launcher, or ""
}

func desktopToolchain() (*toolchain, error) {
	tc := &toolchain{}
	if dir, ok := bundledDesktopDir(); ok {
		tc.binDir = dir
	}
	look := func(name string) string { return lookTool(tc.binDir, name) }

	tc.xvnc = look("Xvnc")
	tc.vncpasswd = look("vncpasswd")
	tc.x11vnc = look("x11vnc")
	tc.xvfb = look("Xvfb")
	for _, wm := range []string{"openbox-session", "openbox", "startxfce4", "xfce4-session", "mate-session", "icewm-session", "icewm", "fluxbox", "jwm", "twm"} {
		if p := look(wm); p != "" {
			tc.wm = p
			break
		}
	}

	switch {
	case tc.xvnc != "" && tc.vncpasswd != "":
		tc.serverName = "Xvnc"
	case tc.x11vnc != "" && tc.xvfb != "":
		tc.serverName = "x11vnc+Xvfb"
	default:
		return nil, fmt.Errorf("no virtual-desktop server available — bundle TigerVNC (Xvnc + vncpasswd) with the agent, or install a VNC server on this host (apt install tigervnc-standalone-server, or x11vnc + xvfb)")
	}
	return tc, nil
}

// launchServer starts the VNC/X server and returns the process(es) to track. Loopback-only.
func (tc *toolchain) launchServer(user string, env []string, display, port int, passFile, dir, geometry string) ([]*exec.Cmd, error) {
	disp := ":" + strconv.Itoa(display)
	logf := filepath.Join(dir, "server.log")

	if tc.serverName == "Xvnc" {
		// TigerVNC Xvnc is a virtual X server that speaks RFB directly. -localhost binds the
		// VNC socket to loopback; -ac disables X11 access control so the local WM can attach
		// without an Xauthority dance (X11 isn't on the network: -nolisten tcp).
		args := []string{disp,
			"-geometry", geometry, "-depth", vncColorDepth,
			"-rfbport", strconv.Itoa(port), "-localhost",
			"-SecurityTypes", "VncAuth", "-PasswordFile", passFile,
			"-ac", "-nolisten", "tcp", "-desktop", "cerebro"}
		cmd, err := startAsUser(user, env, logf, tc.xvnc, args...)
		if err != nil {
			return nil, fmt.Errorf("could not launch Xvnc: %w", err)
		}
		return []*exec.Cmd{cmd}, nil
	}

	// x11vnc + Xvfb: a virtual framebuffer with a VNC server attached to it.
	xvfb, err := startAsUser(user, env, logf, tc.xvfb, disp, "-screen", "0", geometry+"x"+vncColorDepth, "-nolisten", "tcp", "-ac")
	if err != nil {
		return nil, fmt.Errorf("could not launch Xvfb: %w", err)
	}
	for i := 0; i < 20; i++ {
		if fileExists("/tmp/.X11-unix/X" + strconv.Itoa(display)) {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	x11, err := startAsUser(user, append(env, "DISPLAY="+disp), logf,
		tc.x11vnc, "-display", disp, "-rfbport", strconv.Itoa(port), "-localhost",
		"-rfbauth", passFile, "-forever", "-shared", "-noxdamage", "-quiet")
	if err != nil {
		killAll([]*exec.Cmd{xvfb})
		return nil, fmt.Errorf("could not launch x11vnc: %w", err)
	}
	return []*exec.Cmd{xvfb, x11}, nil
}

func (tc *toolchain) launchWM(user string, env []string, dir string) *exec.Cmd {
	if tc.wm == "" {
		log.Print("virtual desktop: no window manager found; showing a bare screen (install openbox for a usable desktop)")
		return nil
	}
	cmd, err := startAsUser(user, env, filepath.Join(dir, "wm.log"), tc.wm)
	if err != nil {
		log.Printf("virtual desktop: window manager %s failed to start: %v (continuing with a bare screen)", tc.wm, err)
		return nil
	}
	return cmd
}

// writePasswd writes the obfuscated VNC password file for the chosen server, owned by the user.
func (tc *toolchain) writePasswd(passFile, password, uid string) error {
	if tc.serverName == "Xvnc" {
		// vncpasswd -f: read the plaintext on stdin, emit the obfuscated blob on stdout.
		cmd := exec.Command(tc.vncpasswd, "-f")
		cmd.Stdin = strings.NewReader(password + "\n")
		out, err := cmd.Output()
		if err != nil {
			return fmt.Errorf("vncpasswd: %w", err)
		}
		if err := os.WriteFile(passFile, out, 0o600); err != nil {
			return err
		}
	} else {
		// x11vnc -storepasswd writes the obfuscated file directly.
		if out, err := exec.Command(tc.x11vnc, "-storepasswd", password, passFile).CombinedOutput(); err != nil {
			return fmt.Errorf("x11vnc -storepasswd: %v: %s", err, strings.TrimSpace(string(out)))
		}
	}
	chownTo(passFile, uid)
	return nil
}

// resolveDesktopUser finds a non-root user to run the virtual desktop as: a logged-in user if
// there is one, else the first ordinary account (uid 1000..60000, real shell, home exists).
func resolveDesktopUser() (string, string, string, error) {
	if out, err := exec.Command("loginctl", "list-sessions", "--no-legend").CombinedOutput(); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) == 0 {
				continue
			}
			props, perr := exec.Command("loginctl", "show-session", fields[0], "-p", "Name", "-p", "User").CombinedOutput()
			if perr != nil {
				continue
			}
			m := parseProps(string(props))
			if u := m["Name"]; u != "" && u != "root" && m["User"] != "0" {
				if home := userHome(u); home != "" {
					return u, m["User"], home, nil
				}
			}
		}
	}
	if out, err := exec.Command("getent", "passwd").CombinedOutput(); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			parts := strings.Split(line, ":")
			if len(parts) < 7 {
				continue
			}
			name, uidStr, home, shell := parts[0], parts[2], parts[5], parts[6]
			uid, err := strconv.Atoi(uidStr)
			if err != nil || uid < 1000 || uid >= 60000 {
				continue
			}
			if shell == "" || strings.HasSuffix(shell, "nologin") || strings.HasSuffix(shell, "false") {
				continue
			}
			if !fileExists(home) {
				continue
			}
			return name, uidStr, home, nil
		}
	}
	return "", "", "", fmt.Errorf("no suitable non-root user found to run a desktop as — create a login account on this host first")
}

func userHome(user string) string {
	if out, err := exec.Command("getent", "passwd", user).CombinedOutput(); err == nil {
		parts := strings.Split(strings.TrimSpace(string(out)), ":")
		if len(parts) >= 6 && fileExists(parts[5]) {
			return parts[5]
		}
	}
	return ""
}

// freeDisplay returns the first X display :N (10..99) with no socket and whose VNC port
// (5900+N) is free.
func freeDisplay() (int, int, error) {
	for n := 10; n < 100; n++ {
		if fileExists("/tmp/.X11-unix/X" + strconv.Itoa(n)) {
			continue
		}
		port := 5900 + n
		if portListening(port) {
			continue
		}
		return n, port, nil
	}
	return 0, 0, fmt.Errorf("no free X display between :10 and :99")
}

// clampSide bounds a requested desktop dimension to a sane range, falling back to def when the
// broker sent nothing (0).
func clampSide(v, def int) int {
	if v <= 0 {
		return def
	}
	if v < minDesktopSide {
		return minDesktopSide
	}
	if v > maxDesktopSide {
		return maxDesktopSide
	}
	return v
}

// lookTool finds a binary in the bundle dir first (if set), otherwise on PATH.
func lookTool(binDir, name string) string {
	if binDir != "" {
		p := filepath.Join(binDir, name)
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return p
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return ""
}

// startAsUser starts a long-running command as the given user (we are root) without waiting,
// returning the Cmd so it can be killed later. Its process group is isolated so teardownDesk
// can take down its children too. Output is appended to logPath when set.
func startAsUser(user string, env []string, logPath, name string, args ...string) (*exec.Cmd, error) {
	full := append([]string{"-u", user, "--", "env"}, env...)
	full = append(full, name)
	full = append(full, args...)
	cmd := exec.Command("runuser", full...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if logPath != "" {
		if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o640); err == nil {
			cmd.Stdout = f
			cmd.Stderr = f
		}
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go func() { _ = cmd.Wait() }() // reap
	return cmd, nil
}

// killAll terminates each command's whole process group (best-effort).
func killAll(cmds []*exec.Cmd) {
	for _, c := range cmds {
		if c == nil || c.Process == nil {
			continue
		}
		if pgid, err := syscall.Getpgid(c.Process.Pid); err == nil {
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		} else {
			_ = c.Process.Kill()
		}
	}
}

func chownTo(path, uid string) {
	if n, err := strconv.Atoi(uid); err == nil {
		_ = os.Chown(path, n, n)
	}
}

// randPassword returns a URL-safe password of n chars from crypto/rand.
func randPassword(n int) string {
	const charset = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is unexpected; fall back to a time-seeded value rather than panic.
		for i := range b {
			b[i] = byte(time.Now().UnixNano() >> uint(i))
		}
	}
	for i := range b {
		b[i] = charset[int(b[i])%len(charset)]
	}
	return string(b)
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func portListening(port int) bool {
	return portOpen(port) // reuse main.go's loopback dial check
}
