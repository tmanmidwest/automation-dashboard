package main

// Parsers for package-manager output. No OS build tags so they're unit-tested
// everywhere (updates_test.go).

import (
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// --- apt ---------------------------------------------------------------------

// `apt-get -s dist-upgrade` lines:
//
//	Inst libssl3 [3.0.2-0ubuntu1.10] (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])
//	Inst linux-image-6.8.0-49-generic (6.8.0-49.49 Ubuntu:24.04/noble-security [amd64])   ← new package
var aptInstRe = regexp.MustCompile(`^Inst (\S+)(?: \[([^\]]*)\])? \((\S+)(?: (.*?))?(?: \[[^\]]*\])?\)`)

func parseAptSim(out string) []pkgUpdate {
	var pkgs []pkgUpdate
	for _, line := range strings.Split(out, "\n") {
		m := aptInstRe.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		origins := strings.TrimSpace(m[4])
		pkgs = append(pkgs, pkgUpdate{
			Name:      m[1],
			Current:   m[2],
			Available: m[3],
			Security:  aptOriginIsSecurity(origins),
			Source:    origins,
		})
	}
	return pkgs
}

func aptOriginIsSecurity(origins string) bool {
	o := strings.ToLower(origins)
	return strings.Contains(o, "-security") || strings.Contains(o, "debian-security") || strings.Contains(o, "/security")
}

// --- dnf / yum ---------------------------------------------------------------

// `dnf -q check-update` rows: "openssl-libs.x86_64   1:3.0.7-27.el9   baseos".
// Stops at "Obsoleting Packages". Security comes from updateinfo (parseDnfSecurity).
func parseDnfCheck(out string) []pkgUpdate {
	var pkgs []pkgUpdate
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		if strings.HasPrefix(t, "Obsoleting") {
			break
		}
		f := strings.Fields(t)
		if len(f) != 3 || !strings.Contains(f[0], ".") {
			continue
		}
		// Header-ish / informational lines don't have a version-like 2nd column.
		if !strings.ContainsAny(f[1], "0123456789") {
			continue
		}
		name := f[0]
		if i := strings.LastIndexByte(name, '.'); i > 0 {
			name = name[:i] // drop .arch
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		pkgs = append(pkgs, pkgUpdate{Name: name, Available: f[1], Source: f[2]})
	}
	return pkgs
}

// `dnf -q updateinfo list --security` rows:
//
//	RHSA-2024:1234  Important/Sec.  openssl-libs-1:3.0.7-27.el9.x86_64
//	FEDORA-2024-abc  low/Sec.        curl-8.6.0-7.fc40.x86_64
//
// Returns package name → severity.
var nevraRe = regexp.MustCompile(`^(.+)-(?:\d+:)?[^-]+-[^-]+\.[^.]+$`)

func parseDnfSecurity(out string) map[string]string {
	sec := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(strings.TrimSpace(line))
		if len(f) < 3 {
			continue
		}
		kind := f[1]
		if !strings.Contains(strings.ToLower(kind), "sec") {
			continue
		}
		m := nevraRe.FindStringSubmatch(f[len(f)-1])
		if m == nil {
			continue
		}
		sev := strings.SplitN(kind, "/", 2)[0]
		if strings.EqualFold(sev, "Sec.") || strings.EqualFold(sev, "security") {
			sev = ""
		}
		if _, ok := sec[m[1]]; !ok || sev != "" {
			sec[m[1]] = capitalize(sev)
		}
	}
	return sec
}

// --- zypper ------------------------------------------------------------------

// `zypper -n -q list-updates` table:
//
//	S | Repository | Name    | Current Version | Available Version | Arch
//	--+------------+---------+-----------------+-------------------+-------
//	v | repo-oss   | openssl | 3.1.4-1.1       | 3.1.4-2.1         | x86_64
func parseZypperList(out string) []pkgUpdate {
	var pkgs []pkgUpdate
	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(line, "|") || strings.Contains(line, "--+--") {
			continue
		}
		cols := strings.Split(line, "|")
		for i := range cols {
			cols[i] = strings.TrimSpace(cols[i])
		}
		if len(cols) < 6 || cols[2] == "Name" || cols[2] == "" {
			continue
		}
		pkgs = append(pkgs, pkgUpdate{Name: cols[2], Current: cols[3], Available: cols[4], Source: cols[1]})
	}
	return pkgs
}

// `zypper -n -q list-patches --category security` table:
//
//	Repository | Name | Category | Severity | Interactive | Status | Summary
func parseZypperPatches(out string) []pkgUpdate {
	var pkgs []pkgUpdate
	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(line, "|") || strings.Contains(line, "--+--") {
			continue
		}
		cols := strings.Split(line, "|")
		for i := range cols {
			cols[i] = strings.TrimSpace(cols[i])
		}
		if len(cols) < 6 || cols[1] == "Name" || cols[1] == "" {
			continue
		}
		if st := strings.ToLower(cols[5]); st != "" && st != "needed" {
			continue
		}
		p := pkgUpdate{Name: cols[1], Security: true, Severity: cols[3], Source: cols[0]}
		if len(cols) > 6 {
			p.Available = cols[6]
		}
		pkgs = append(pkgs, p)
	}
	return pkgs
}

// --- pacman / apk --------------------------------------------------------------

// `checkupdates` lines: "openssl 3.3.1-1 -> 3.3.2-1".
func parseCheckupdates(out string) []pkgUpdate {
	var pkgs []pkgUpdate
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) == 4 && f[2] == "->" {
			pkgs = append(pkgs, pkgUpdate{Name: f[0], Current: f[1], Available: f[3]})
		}
	}
	return pkgs
}

// `apk version -l '<'` lines: "busybox-1.36.1-r15   < 1.36.1-r16".
var apkVerRe = regexp.MustCompile(`^(.+?)-(\d[^\s]*-r\d+)\s+<\s+(\S+)`)

func parseApkVersion(out string) []pkgUpdate {
	var pkgs []pkgUpdate
	for _, line := range strings.Split(out, "\n") {
		m := apkVerRe.FindStringSubmatch(strings.TrimSpace(line))
		if m != nil {
			pkgs = append(pkgs, pkgUpdate{Name: m[1], Current: m[2], Available: m[3]})
		}
	}
	return pkgs
}

// --- macOS softwareupdate ------------------------------------------------------

//   - Label: macOS Sonoma 14.2.1-23C71
//     Title: macOS Sonoma 14.2.1, Version: 14.2.1, Size: 1234K, Recommended: YES, Action: restart,
var macTitleKV = regexp.MustCompile(`(\w[\w ]*?):\s*([^,]*)`)

func parseSoftwareUpdate(out string, appleSilicon bool) []pkgUpdate {
	var pkgs []pkgUpdate
	var cur *pkgUpdate
	for _, raw := range strings.Split(out, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "* Label:") {
			if cur != nil {
				pkgs = append(pkgs, *cur)
			}
			cur = &pkgUpdate{Name: strings.TrimSpace(strings.TrimPrefix(line, "* Label:"))}
			continue
		}
		if cur == nil || !strings.HasPrefix(line, "Title:") {
			continue
		}
		title := ""
		for _, m := range macTitleKV.FindAllStringSubmatch(line, -1) {
			k, v := strings.TrimSpace(m[1]), strings.TrimSpace(m[2])
			switch k {
			case "Title":
				title = v
			case "Version":
				cur.Available = v
			case "Action":
				if strings.EqualFold(v, "restart") || strings.EqualFold(v, "shut down") {
					cur.Restart = true
				}
			}
		}
		if title != "" {
			cur.Source = title
		}
		t := strings.ToLower(title + " " + cur.Name)
		cur.Security = strings.Contains(t, "security")
		// Apple silicon won't install a restart-requiring system update without an
		// owner's password, so it can't happen unattended.
		cur.NeedsUser = appleSilicon && cur.Restart && (strings.HasPrefix(t, "macos") || strings.Contains(t, "security response"))
	}
	if cur != nil {
		pkgs = append(pkgs, *cur)
	}
	return pkgs
}

// --- Windows Update (JSON from the check script) -----------------------------

type winCheckOut struct {
	Error         string          `json:"error"`
	RebootPending bool            `json:"rebootPending"`
	Reasons       json.RawMessage `json:"reasons"`
	Updates       json.RawMessage `json:"updates"`
}

type winUpdate struct {
	Title      string          `json:"title"`
	KB         string          `json:"kb"`
	Severity   string          `json:"severity"`
	Categories json.RawMessage `json:"categories"`
	Reboot     bool            `json:"reboot"`
}

// stringsOrOne decodes a JSON string array that PowerShell may have collapsed to a single string.
func stringsOrOne(raw json.RawMessage) []string {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var arr []string
	if json.Unmarshal(raw, &arr) == nil {
		return arr
	}
	var one string
	if json.Unmarshal(raw, &one) == nil && one != "" {
		return []string{one}
	}
	return nil
}

func parseWinCheck(out string) (pkgs []pkgUpdate, rebootPending bool, reason string, errMsg string) {
	out = strings.TrimSpace(out)
	if i := strings.IndexByte(out, '{'); i > 0 {
		out = out[i:]
	}
	var w winCheckOut
	if err := json.Unmarshal([]byte(out), &w); err != nil {
		return nil, false, "", "couldn't read Windows Update's answer: " + firstLine(out)
	}
	var list []winUpdate
	if len(w.Updates) > 0 && string(w.Updates) != "null" {
		if json.Unmarshal(w.Updates, &list) != nil {
			var one winUpdate
			if json.Unmarshal(w.Updates, &one) == nil && one.Title != "" {
				list = []winUpdate{one}
			}
		}
	}
	for _, u := range list {
		cats := stringsOrOne(u.Categories)
		sec := u.Severity != ""
		for _, c := range cats {
			if c == "Security Updates" || c == "Critical Updates" {
				sec = true
			}
		}
		kb := ""
		if u.KB != "" {
			kb = "KB" + strings.TrimPrefix(u.KB, "KB")
		}
		pkgs = append(pkgs, pkgUpdate{Name: u.Title, KB: kb, Severity: u.Severity, Security: sec, Restart: u.Reboot, Source: strings.Join(cats, ", ")})
	}
	return pkgs, w.RebootPending, strings.Join(stringsOrOne(w.Reasons), ", "), w.Error
}

// --- kernels -----------------------------------------------------------------

// newestKernel picks the highest version among /boot/vmlinuz-<ver> names.
func newestKernel(versions []string) string {
	if len(versions) == 0 {
		return ""
	}
	vs := append([]string(nil), versions...)
	sort.Slice(vs, func(i, j int) bool { return naturalLess(vs[i], vs[j]) })
	return vs[len(vs)-1]
}

// naturalLess compares strings with digit runs compared numerically ("6.8.12-4" < "6.8.12-10").
func naturalLess(a, b string) bool {
	for a != "" && b != "" {
		ca, cb := rune(a[0]), rune(b[0])
		if unicode.IsDigit(ca) && unicode.IsDigit(cb) {
			na, ra := leadingNum(a)
			nb, rb := leadingNum(b)
			if na != nb {
				return na < nb
			}
			a, b = ra, rb
			continue
		}
		if ca != cb {
			return ca < cb
		}
		a, b = a[1:], b[1:]
	}
	return len(a) < len(b)
}

func leadingNum(s string) (int, string) {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	n, _ := strconv.Atoi(s[:i])
	return n, s[i:]
}

func countSecurity(pkgs []pkgUpdate) int {
	n := 0
	for _, p := range pkgs {
		if p.Security {
			n++
		}
	}
	return n
}

func capitalize(s string) string {
	s = strings.ToLower(s)
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
