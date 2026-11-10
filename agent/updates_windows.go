//go:build windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Windows: the Windows Update Agent COM API (what Settings → Windows Update
// uses), driven by small PowerShell scripts. The agent runs as SYSTEM, which is
// allowed to download and install.

type windowsUpdater struct{}

func newOSUpdater() osUpdater { return windowsUpdater{} }

const winCheckScript = `$ErrorActionPreference = 'Stop'
$out = @{ updates = @(); rebootPending = $false; reasons = @() }
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $session.ClientApplicationID = 'Cerebro agent'
  $res = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
  foreach ($u in $res.Updates) {
    $cats = @($u.Categories | ForEach-Object { $_.Name })
    $out.updates += [pscustomobject]@{
      title = [string]$u.Title
      kb = (@($u.KBArticleIDs) -join ',')
      severity = [string]$u.MsrcSeverity
      categories = $cats
      reboot = ($u.InstallationBehavior.RebootBehavior -ne 0)
    }
  }
} catch { $out.error = $_.Exception.Message }
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') { $out.rebootPending = $true; $out.reasons += 'Windows Update' }
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') { $out.rebootPending = $true; $out.reasons += 'Component servicing' }
$out | ConvertTo-Json -Depth 5 -Compress
`

const winInstallScript = `param([string]$Scope = 'all')
$ErrorActionPreference = 'Stop'
$session = New-Object -ComObject Microsoft.Update.Session
$session.ClientApplicationID = 'Cerebro agent'
Write-Output 'Searching for updates...'
$res = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
$coll = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $res.Updates) {
  $cats = @($u.Categories | ForEach-Object { $_.Name })
  $sec = ($cats -contains 'Security Updates') -or ($cats -contains 'Critical Updates') -or ([string]$u.MsrcSeverity -ne '')
  if ($Scope -eq 'security' -and -not $sec) { continue }
  if ($u.InstallationBehavior.CanRequestUserInput) { Write-Output ("Skipping (needs someone at the PC): " + $u.Title); continue }
  if (-not $u.EulaAccepted) { $u.AcceptEula() }
  [void]$coll.Add($u)
  Write-Output ("Queued: " + $u.Title)
}
if ($coll.Count -eq 0) {
  Write-Output 'Nothing to install.'
  Write-Output 'RESULT {"ok":true,"installed":0,"failed":0,"reboot":false}'
  exit 0
}
Write-Output ("Downloading " + $coll.Count + " update(s)...")
$dl = $session.CreateUpdateDownloader()
$dl.Updates = $coll
$d = $dl.Download()
Write-Output ("Download finished (result " + $d.ResultCode + ")")
Write-Output 'Installing...'
$inst = $session.CreateUpdateInstaller()
$inst.Updates = $coll
$r = $inst.Install()
$failed = 0
for ($i = 0; $i -lt $coll.Count; $i++) {
  $code = $r.GetUpdateResult($i).ResultCode
  $word = switch ($code) { 2 { 'Installed' } 3 { 'Installed with errors' } 4 { 'Failed' } 5 { 'Aborted' } default { 'Result ' + $code } }
  if ($code -ge 4) { $failed++ }
  Write-Output ($word + ': ' + $coll.Item($i).Title)
}
$ok = (($r.ResultCode -eq 2) -or ($r.ResultCode -eq 3)) -and ($failed -eq 0)
Write-Output ('RESULT ' + (@{ ok = $ok; installed = ($coll.Count - $failed); failed = $failed; reboot = [bool]$r.RebootRequired } | ConvertTo-Json -Compress))
if ($ok) { exit 0 } else { exit 1 }
`

func writeTempScript(body string) (string, func(), error) {
	dir, err := os.MkdirTemp("", "cerebro-updates-")
	if err != nil {
		return "", func() {}, err
	}
	p := filepath.Join(dir, "run.ps1")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		os.RemoveAll(dir)
		return "", func() {}, err
	}
	return p, func() { os.RemoveAll(dir) }, nil
}

func psArgs(script string, extra ...string) []string {
	return append([]string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script}, extra...)
}

func (windowsUpdater) check(ctx context.Context) updatesReport {
	rep := updatesReport{Manager: "windows-update", Supported: true, CanInstall: true, SecurityKnown: true}
	p, cleanup, err := writeTempScript(winCheckScript)
	if err != nil {
		rep.Error = "couldn't write the check script: " + err.Error()
		return rep
	}
	defer cleanup()
	out, _, err := runOut(ctx, nil, "powershell.exe", psArgs(p)...)
	if err != nil {
		rep.Error = "PowerShell didn't start: " + err.Error()
		return rep
	}
	pkgs, pending, reason, errMsg := parseWinCheck(out)
	rep.Packages = pkgs
	rep.Total = len(pkgs)
	rep.Security = countSecurity(pkgs)
	rep.RebootRequired = pending
	if pending {
		rep.RebootReason = "Pending restart: " + reason
	}
	if errMsg != "" {
		rep.Error = "Windows Update: " + errMsg
	}
	return rep
}

func (windowsUpdater) install(ctx context.Context, scope string, logf func(string)) (int, error) {
	p, cleanup, err := writeTempScript(winInstallScript)
	if err != nil {
		return -1, &cmdError{msg: "couldn't write the install script: " + err.Error(), code: -1}
	}
	defer cleanup()
	var result struct {
		OK        bool `json:"ok"`
		Installed int  `json:"installed"`
		Failed    int  `json:"failed"`
	}
	got := false
	wrapped := func(line string) {
		if strings.HasPrefix(line, "RESULT ") {
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "RESULT ")), &result) == nil {
				got = true
			}
			return
		}
		logf(line)
	}
	err = runStream(ctx, nil, wrapped, "powershell.exe", psArgs(p, "-Scope", scope)...)
	if got {
		if !result.OK {
			return result.Installed, &cmdError{msg: fmt.Sprintf("%d update(s) failed to install.", result.Failed), code: 1}
		}
		return result.Installed, nil
	}
	if err == nil {
		err = &cmdError{msg: "Windows Update finished without a result.", code: -1}
	}
	return -1, err
}

func (windowsUpdater) reboot() error {
	return exec.Command("shutdown.exe", "/r", "/t", "60", "/d", "p:2:17", "/c", "Cerebro: restarting to finish updates").Run()
}
