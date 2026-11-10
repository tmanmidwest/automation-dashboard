package main

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseAptSim(t *testing.T) {
	out := `NOTE: This is only a simulation!
Reading package lists...
Inst libssl3 [3.0.2-0ubuntu1.10] (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])
Inst linux-image-6.8.0-49-generic (6.8.0-49.49 Ubuntu:24.04/noble-security [amd64])
Inst pve-manager [8.2.4] (8.2.7 Proxmox:8.2/bookworm [amd64])
Inst tzdata [2024a-0+deb12u1] (2024b-0+deb12u1 Debian:12.7/stable, Debian-Security:12/stable-security [all])
Conf libssl3 (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-updates [amd64])`
	p := parseAptSim(out)
	if len(p) != 4 {
		t.Fatalf("want 4 packages, got %d: %+v", len(p), p)
	}
	if p[0].Name != "libssl3" || p[0].Current != "3.0.2-0ubuntu1.10" || p[0].Available != "3.0.2-0ubuntu1.12" || !p[0].Security {
		t.Errorf("libssl3 parsed wrong: %+v", p[0])
	}
	if p[1].Current != "" || !p[1].Security {
		t.Errorf("new kernel package parsed wrong: %+v", p[1])
	}
	if p[2].Security || p[2].Available != "8.2.7" {
		t.Errorf("pve-manager parsed wrong: %+v", p[2])
	}
	if !p[3].Security {
		t.Errorf("Debian-Security origin not marked: %+v", p[3])
	}
}

func TestParseDnf(t *testing.T) {
	check := `
openssl-libs.x86_64          1:3.0.7-27.el9          baseos
curl.x86_64                  7.76.1-29.el9_4.1       baseos
kernel.x86_64                5.14.0-427.42.1.el9_4   baseos
Obsoleting Packages
grub2-tools.x86_64           1:2.06-80.el9           baseos`
	p := parseDnfCheck(check)
	if len(p) != 3 || p[0].Name != "openssl-libs" || p[1].Available != "7.76.1-29.el9_4.1" {
		t.Fatalf("dnf check-update parsed wrong: %+v", p)
	}
	sec := parseDnfSecurity(`RHSA-2024:1234 Important/Sec. openssl-libs-1:3.0.7-27.el9.x86_64
RHSA-2024:2222 Moderate/Sec.  curl-7.76.1-29.el9_4.1.x86_64
RHBA-2024:9999 bugfix         kernel-5.14.0-427.42.1.el9_4.x86_64`)
	if sec["openssl-libs"] != "Important" || sec["curl"] != "Moderate" {
		t.Errorf("security map wrong: %v", sec)
	}
	if _, ok := sec["kernel"]; ok {
		t.Errorf("bugfix advisory marked as security")
	}
}

func TestParseZypper(t *testing.T) {
	list := `S | Repository     | Name    | Current Version | Available Version | Arch
--+----------------+---------+-----------------+-------------------+-------
v | repo-oss       | openssl | 3.1.4-1.1       | 3.1.4-2.1         | x86_64
v | repo-update    | vim     | 9.1-1.1         | 9.1-2.1           | x86_64`
	p := parseZypperList(list)
	if len(p) != 2 || p[0].Name != "openssl" || p[0].Current != "3.1.4-1.1" || p[1].Available != "9.1-2.1" {
		t.Fatalf("zypper list parsed wrong: %+v", p)
	}
	patches := parseZypperPatches(`Repository  | Name                 | Category | Severity  | Interactive | Status | Summary
------------+----------------------+----------+-----------+-------------+--------+--------
repo-update | openSUSE-2024-123    | security | important | ---         | needed | Security update for openssl
repo-update | openSUSE-2024-100    | security | low       | ---         | applied | Old`)
	if len(patches) != 1 || patches[0].Severity != "important" || !patches[0].Security {
		t.Fatalf("zypper patches parsed wrong: %+v", patches)
	}
}

func TestParsePacmanApk(t *testing.T) {
	p := parseCheckupdates("openssl 3.3.1-1 -> 3.3.2-1\nlinux 6.10.1.arch1-1 -> 6.10.2.arch1-1\n")
	if len(p) != 2 || p[1].Name != "linux" || p[1].Available != "6.10.2.arch1-1" {
		t.Fatalf("checkupdates parsed wrong: %+v", p)
	}
	a := parseApkVersion("Installed:                                Available:\nbusybox-1.36.1-r15            < 1.36.1-r16\nca-certificates-bundle-20240226-r0 < 20240705-r0\n")
	if len(a) != 2 || a[0].Name != "busybox" || a[0].Current != "1.36.1-r15" || a[1].Name != "ca-certificates-bundle" {
		t.Fatalf("apk parsed wrong: %+v", a)
	}
}

func TestParseSoftwareUpdate(t *testing.T) {
	out := `Software Update Tool

Finding available software
Software Update found the following new or updated software:
* Label: macOS Sonoma 14.2.1-23C71
	Title: macOS Sonoma 14.2.1, Version: 14.2.1, Size: 1234567K, Recommended: YES, Action: restart,
* Label: Safari17.2.1SonomaAuto-17.2.1
	Title: Safari, Version: 17.2.1, Size: 160250K, Recommended: YES,
* Label: Background Security Improvement-14.2.1 (a)
	Title: Background Security Improvement, Version: 14.2.1 (a), Size: 1024K, Recommended: YES, Action: restart,
`
	p := parseSoftwareUpdate(out, true)
	if len(p) != 3 {
		t.Fatalf("want 3, got %+v", p)
	}
	if !p[0].Restart || !p[0].NeedsUser || p[0].Available != "14.2.1" || p[0].Source != "macOS Sonoma 14.2.1" {
		t.Errorf("macOS update parsed wrong: %+v", p[0])
	}
	if p[1].Restart || p[1].NeedsUser || p[1].Security {
		t.Errorf("Safari parsed wrong: %+v", p[1])
	}
	if !p[2].Security {
		t.Errorf("security improvement not marked: %+v", p[2])
	}
	if intel := parseSoftwareUpdate(out, false); intel[0].NeedsUser {
		t.Errorf("Intel Macs can install macOS unattended")
	}
}

func TestParseWinCheck(t *testing.T) {
	out := `{"rebootPending":true,"reasons":"Windows Update","updates":[{"title":"2024-11 Cumulative Update for Windows 11 (KB5046617)","kb":"5046617","severity":"Critical","categories":["Security Updates","Windows 11"],"reboot":true},{"title":"Security Intelligence Update for Microsoft Defender","kb":"2267602","severity":"","categories":"Definition Updates","reboot":false}]}`
	p, pending, reason, errMsg := parseWinCheck(out)
	if errMsg != "" || !pending || reason != "Windows Update" || len(p) != 2 {
		t.Fatalf("windows check parsed wrong: %+v %v %q %q", p, pending, reason, errMsg)
	}
	if !p[0].Security || p[0].KB != "KB5046617" || !p[0].Restart {
		t.Errorf("cumulative update parsed wrong: %+v", p[0])
	}
	if p[1].Security || p[1].Source != "Definition Updates" {
		t.Errorf("defender update parsed wrong: %+v", p[1])
	}
	// One update: PowerShell may collapse the array to an object.
	p, _, _, _ = parseWinCheck(`{"rebootPending":false,"updates":{"title":"One","kb":"1","severity":"","categories":["Updates"],"reboot":false}}`)
	if len(p) != 1 || p[0].Name != "One" {
		t.Errorf("single update parsed wrong: %+v", p)
	}
}

func TestNewestKernel(t *testing.T) {
	if k := newestKernel([]string{"6.8.12-4-pve", "6.8.12-10-pve", "6.5.13-6-pve"}); k != "6.8.12-10-pve" {
		t.Errorf("got %s", k)
	}
	if !naturalLess("5.15.0-9-generic", "5.15.0-10-generic") {
		t.Errorf("natural sort wrong")
	}
}

func TestScanLinesCR(t *testing.T) {
	sc := bufio.NewScanner(strings.NewReader("a\r\nb\rc\nd"))
	sc.Split(scanLinesCR)
	var got []string
	for sc.Scan() {
		got = append(got, sc.Text())
	}
	if strings.Join(got, "|") != "a|b|c|d" {
		t.Errorf("got %v", got)
	}
}

func TestUpdatesAuthorized(t *testing.T) {
	dir := t.TempDir()
	cfg := config{StateDir: dir}
	secret := "s3cret"
	cred := "cbroagent_abc_" + secret
	// No pinned key → legacy, allowed.
	if !updatesAuthorized(cfg, cred, 0, "", "run1", "install", "all", "never") {
		t.Fatal("legacy agent should accept")
	}
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	if err := os.WriteFile(filepath.Join(dir, "update-key.pub"), []byte(base64.StdEncoding.EncodeToString(pub)), 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(secret))
	ch := hex.EncodeToString(sum[:])
	now := time.Now().Unix()
	sign := func(msg string) string { return base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(msg))) }
	good := sign(fmt.Sprintf("updates:%s:%d:run1:install:all:never", ch, now))
	if !updatesAuthorized(cfg, cred, now, good, "run1", "install", "all", "never") {
		t.Fatal("valid signature refused")
	}
	if updatesAuthorized(cfg, cred, now, good, "run1", "install", "all", "always") {
		t.Fatal("changed reboot option accepted")
	}
	if updatesAuthorized(cfg, cred, now, "", "run1", "install", "all", "never") {
		t.Fatal("missing signature accepted with a pinned key")
	}
	old := now - 7200
	if updatesAuthorized(cfg, cred, old, sign(fmt.Sprintf("updates:%s:%d:run1:install:all:never", ch, old)), "run1", "install", "all", "never") {
		t.Fatal("stale signature accepted")
	}
	// uninstall still works through the shared check.
	if !uninstallAuthorized(cfg, cred, now, sign(fmt.Sprintf("uninstall:%s:%d", ch, now))) {
		t.Fatal("uninstall signature refused")
	}
}

// A real check on the machine running the tests (Linux CI / dev box). Only
// reported, never fails on content: what's pending depends on the box.
func TestRealCheck(t *testing.T) {
	if testing.Short() || os.Getenv("CEREBRO_TEST_REAL_UPDATES") == "" {
		t.Skip("set CEREBRO_TEST_REAL_UPDATES=1 to run a real update check")
	}
	u := &updater{mode: "on", impl: newOSUpdater(), checkNow: make(chan struct{}, 1), outbox: make(chan map[string]any, 64)}
	rep := u.checkOnce(true)
	t.Logf("manager=%s supported=%v total=%d security=%d reboot=%v (%s) note=%q err=%q", rep.Manager, rep.Supported, rep.Total, rep.Security, rep.RebootRequired, rep.RebootReason, rep.Note, rep.Error)
	for i, p := range rep.Packages {
		if i >= 5 {
			break
		}
		t.Logf("  %+v", p)
	}
}
