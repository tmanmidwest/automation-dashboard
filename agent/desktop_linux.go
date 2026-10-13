//go:build linux

package main

// Fabric Remote Desktop P1 (Linux): enable the box's REAL logged-in desktop for remote
// control with no command line on the box, by driving gnome-remote-desktop (the only way
// to reach the actual screen on Wayland, which modern Ubuntu Desktop uses by default).
//
// The broker sends a one-time credential; we configure grd's RDP with it (generating a
// self-signed TLS cert grd requires), enable it, and report back that RDP is live on the
// loopback port. The broker then brokers an RDP session there like any other.
//
// This is best-effort across GNOME versions (grdctl's surface shifts between 22.04/24.04);
// every failure returns a descriptive error that the broker surfaces to the operator, so
// the exact grdctl output guides iteration. A bundled virtual desktop (for headless or
// non-GNOME boxes) is a later phase.

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const grdRdpPort = 3389

// startDesktop configures the real desktop for remote control and returns the protocol +
// loopback port to broker to. P1 supports Wayland GNOME via gnome-remote-desktop (RDP).
func startDesktop(username, password, _ string) (string, int, error) {
	user, uid, sessionType, err := activeGraphicalSession()
	if err != nil {
		return "", 0, fmt.Errorf("no active graphical desktop session found (%v) — is someone logged in at the screen? A bundled virtual desktop for headless boxes lands in a later phase", err)
	}
	env := []string{
		"XDG_RUNTIME_DIR=/run/user/" + uid,
		"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/" + uid + "/bus",
	}
	if _, err := runAsUser(user, env, "sh", "-c", "command -v grdctl"); err != nil {
		return "", 0, fmt.Errorf("gnome-remote-desktop (grdctl) is not available for %s's %s session — P1 drives the real desktop via gnome-remote-desktop; a bundled desktop server is a later phase", user, sessionType)
	}

	crt, key, err := ensureTLSCert(uid)
	if err != nil {
		return "", 0, fmt.Errorf("could not prepare a TLS certificate for gnome-remote-desktop: %w", err)
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
			return "", 0, fmt.Errorf("gnome-remote-desktop setup failed at `%s`: %v: %s", strings.Join(step, " "), err, strings.TrimSpace(out))
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
		return "", 0, fmt.Errorf("gnome-remote-desktop was enabled for %s but nothing is listening on 127.0.0.1:%d yet — on some GNOME versions RDP only starts once the user has unlocked the session", user, grdRdpPort)
	}
	return "rdp", grdRdpPort, nil
}

// stopDesktop reverts the remote-desktop enablement (best-effort).
func stopDesktop() error {
	user, uid, _, err := activeGraphicalSession()
	if err != nil {
		return nil // nothing we can target; let it be
	}
	env := []string{
		"XDG_RUNTIME_DIR=/run/user/" + uid,
		"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/" + uid + "/bus",
	}
	_, _ = runAsUser(user, env, "grdctl", "rdp", "disable")
	return nil
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

// runAsUser runs a command as the given user (we are root) with the supplied extra env,
// using runuser (util-linux, present on Ubuntu, no password needed for root). Returns the
// combined output.
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

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func portListening(port int) bool {
	return portOpen(port) // reuse main.go's loopback dial check
}
