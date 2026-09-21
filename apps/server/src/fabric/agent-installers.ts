/**
 * Bootstrap installers served (unauthenticated) at /api/fabric/install.sh and
 * install.ps1. They are generic — the enrollment token is passed in the
 * environment by the copy-paste one-liner, never baked into the script — so the
 * scripts themselves are safe to serve publicly.
 *
 * Each downloads the matching agent binary from Cerebro, drops a config file
 * carrying CEREBRO_URL + the one-time ENROLL token, and installs a service. On
 * first start the agent exchanges ENROLL for its long-lived credential.
 *
 * CEREBRO_MODE selects the install identity: "endpoint" (default) uses the
 * cerebro-agent service/dir; "waypoint" uses cerebro-waypoint. They are distinct
 * so an endpoint agent and a Waypoint can coexist on one box (the agent takes the
 * same mode as a `--mode` flag). See docs/fabric-waypoints.md.
 */

export function installSh(): string {
  return `#!/bin/sh
# Cerebro Fabric agent / Waypoint installer (Linux + macOS — auto-detected).
# See docs/fabric-waypoints.md.
set -eu

: "\${CEREBRO_URL:?Set CEREBRO_URL, e.g. https://cerebro.example}"
: "\${ENROLL:?Set ENROLL to the one-time enrollment token}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

MODE="\${CEREBRO_MODE:-endpoint}"
if [ "$MODE" = "waypoint" ]; then
  NAME=cerebro-waypoint
  LABEL=com.cerebro.waypoint
  DISPLAY="Cerebro Waypoint"
else
  MODE=endpoint
  NAME=cerebro-agent
  LABEL=com.cerebro.agent
  DISPLAY="Cerebro Fabric Agent"
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) GOARCH=amd64 ;;
  aarch64|arm64) GOARCH=arm64 ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

OS="linux"
[ "$(uname)" = "Darwin" ] && OS="darwin"

BIN=/usr/local/bin/$NAME
CFG=/etc/$NAME

command -v curl >/dev/null 2>&1 || { echo "curl is required but not installed. Install curl and re-run." >&2; exit 1; }

# A saved credential means this box already enrolled. The agent will reuse it and
# IGNORE the ENROLL token below — so a fresh token won't take effect until the old
# credential is removed. Flag it so a stale enrollment isn't a silent mystery.
if [ -f "$CFG/credential" ]; then
  echo "Note: $DISPLAY is already enrolled on this box ($CFG/credential); reusing the saved credential (the ENROLL token is ignored). To force a clean re-enrollment, stop the service and 'rm -rf $CFG' first."
fi

echo "Downloading cerebro-agent ($OS/$GOARCH) for $DISPLAY..."
mkdir -p "$(dirname "$BIN")"
# Download to a temp file in the SAME directory, then atomically rename into
# place. A plain "curl -o $BIN" writes into the destination inode, which fails
# with "text file busy" (curl error 23) when $BIN is a currently-running agent
# (re-install / self-update). A rename swaps the directory entry instead, so the
# running process keeps its old inode and the new binary lands cleanly.
TMP="$BIN.new.$$"
trap 'rm -f "$TMP"' EXIT
if ! curl -fsSL "\${CEREBRO_URL}/api/fabric/agent/binary?os=\${OS}&arch=\${GOARCH}" -o "$TMP"; then
  echo "Download failed. If this was 'text file busy', an old copy is running — 'systemctl stop $NAME' (or 'launchctl bootout system/$LABEL') and re-run. Otherwise check disk space and that $CEREBRO_URL is reachable." >&2
  exit 1
fi
[ -s "$TMP" ] || { echo "Downloaded binary is empty — aborting (is $CEREBRO_URL correct and serving the agent?)." >&2; exit 1; }
chmod 0755 "$TMP"
mv -f "$TMP" "$BIN"
trap - EXIT

mkdir -p "$CFG"
chmod 0700 "$CFG"
cat > "$CFG/config.env" <<EOF
CEREBRO_URL=\${CEREBRO_URL}
ENROLL=\${ENROLL}
CEREBRO_MODE=\${MODE}
EOF
chmod 0600 "$CFG/config.env"

# --- Post-install validation --------------------------------------------------
# Recent agent logs SINCE this install started (journald on Linux, the launchd log
# file on macOS) — scoped to this run so a stale "connected" line from an earlier
# install can't produce a false pass. START_TS is set just before we (re)start.
read_logs() {
  if command -v journalctl >/dev/null 2>&1; then
    journalctl -u "$NAME" --since "$START_TS" -n 200 --no-pager 2>/dev/null || true
  elif [ -f "/var/log/$NAME.log" ]; then
    tail -n 200 "/var/log/$NAME.log" 2>/dev/null || true
  fi
}

# Poll the logs for up to ~20s. 0 = connected, 2 = rejected/failed, 1 = unknown.
wait_connect() {
  i=0
  while [ "$i" -lt 20 ]; do
    logs="$(read_logs)"
    case "$logs" in
      *"connected to"*) return 0 ;;
    esac
    case "$logs" in
      *"credential refused"*|*"enrollment failed"*|*"enroll rejected"*|*"removed in Cerebro"*|*"410 Gone"*) return 2 ;;
    esac
    i=$((i + 1))
    sleep 1
  done
  return 1
}

report_result() {
  echo "Waiting for $DISPLAY to connect to Cerebro..."
  if wait_connect; then rc=0; else rc=$?; fi
  if [ "$rc" = 0 ]; then
    echo "✓ $DISPLAY connected to Cerebro."
    exit 0
  fi
  echo "" >&2
  if [ "$rc" = 2 ]; then
    echo "✗ $DISPLAY started but Cerebro REFUSED it — most likely a stale enrollment on this box, or the agent was removed in Cerebro." >&2
  else
    echo "✗ $DISPLAY started but did not confirm a connection within 20s." >&2
  fi
  echo "  Recent logs:" >&2
  read_logs | tail -n 12 | sed 's/^/    /' >&2
  echo "" >&2
  echo "  To re-enroll cleanly, wipe the saved credential and re-run this installer with a NEW token from Cerebro:" >&2
  if [ "$OS" = "darwin" ]; then
    echo "    sudo launchctl bootout system/$LABEL 2>/dev/null; sudo rm -rf $CFG" >&2
  else
    echo "    sudo systemctl stop $NAME; sudo rm -rf $CFG" >&2
  fi
  exit 1
}

if [ "$OS" = "darwin" ]; then
  PLIST=/Library/LaunchDaemons/$LABEL.plist
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string><string>--mode</string><string>$MODE</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>CEREBRO_URL</key><string>\${CEREBRO_URL}</string>
    <key>ENROLL</key><string>\${ENROLL}</string>
    <key>CEREBRO_MODE</key><string>$MODE</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>/var/log/$NAME.log</string>
  <key>StandardOutPath</key><string>/var/log/$NAME.log</string>
</dict></plist>
EOF
  chmod 0644 "$PLIST"
  launchctl bootout system "$PLIST" 2>/dev/null || true
  : > "/var/log/$NAME.log" 2>/dev/null || true  # clean slate for the connect check
  START_TS="$(date '+%Y-%m-%d %H:%M:%S')"
  launchctl bootstrap system "$PLIST"
  echo "$DISPLAY installed (launchd)."
  report_result
fi

cat > /etc/systemd/system/$NAME.service <<EOF
[Unit]
Description=$DISPLAY
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/$NAME/config.env
ExecStart=$BIN --mode $MODE
Restart=always
RestartSec=5
# Runs as root so the agent can self-uninstall (stop its service + remove its
# files) when it is deleted from Cerebro.

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable $NAME.service
START_TS="$(date '+%Y-%m-%d %H:%M:%S')"
# restart (not "enable --now") so a re-install actually swaps in the new binary
# even when the service is already running.
systemctl restart $NAME.service
echo "$DISPLAY installed."
report_result
`;
}

export function uninstallSh(): string {
  return `#!/bin/sh
# Cerebro Fabric agent / Waypoint uninstaller + cleanup (Linux + macOS — auto-detected).
#   CEREBRO_MODE=waypoint  → remove a Waypoint
#   CEREBRO_MODE=endpoint  → remove the endpoint agent (default)
#   CEREBRO_MODE=all       → remove both, if present
# NOT set -e: we push through every best-effort removal step, then verify.
set -u

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

# remove_one <mode> — stop, disable, delete, purge, kill-lingering, then verify.
remove_one() {
  m="$1"
  if [ "$m" = "waypoint" ]; then NAME=cerebro-waypoint; LABEL=com.cerebro.waypoint
  else NAME=cerebro-agent; LABEL=com.cerebro.agent; fi
  BIN=/usr/local/bin/$NAME

  if [ "$(uname)" = "Darwin" ]; then
    PLIST=/Library/LaunchDaemons/$LABEL.plist
    launchctl bootout system "$PLIST" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST" "$BIN"
    rm -rf /etc/$NAME
    pkill -f "$BIN" 2>/dev/null || true
    still=0
    [ -e "$BIN" ] && still=1
    [ -e "$PLIST" ] && still=1
    pgrep -f "$BIN" >/dev/null 2>&1 && still=1
  else
    systemctl stop $NAME 2>/dev/null || true
    systemctl disable $NAME 2>/dev/null || true
    rm -f /etc/systemd/system/$NAME.service \\
          /etc/systemd/system/multi-user.target.wants/$NAME.service "$BIN"
    rm -rf /etc/$NAME /var/lib/$NAME
    systemctl daemon-reload 2>/dev/null || true
    systemctl reset-failed $NAME 2>/dev/null || true
    pkill -f "$BIN" 2>/dev/null || true
    still=0
    [ -e "$BIN" ] && still=1
    [ -e /etc/systemd/system/$NAME.service ] && still=1
    systemctl is-active --quiet $NAME 2>/dev/null && still=1
  fi

  if [ "$still" = 1 ]; then
    echo "⚠ $NAME may not be fully removed:" >&2
    [ -e "$BIN" ] && echo "    binary still present: $BIN" >&2
    [ "$(uname)" != "Darwin" ] && [ -e /etc/systemd/system/$NAME.service ] && echo "    unit still present: /etc/systemd/system/$NAME.service" >&2
    [ "$(uname)" != "Darwin" ] && systemctl is-active --quiet $NAME 2>/dev/null && echo "    service still active — try: sudo systemctl stop $NAME" >&2
    UNINSTALL_INCOMPLETE=1
  else
    echo "✓ $NAME removed."
  fi
}

UNINSTALL_INCOMPLETE=0
MODE="\${CEREBRO_MODE:-endpoint}"
if [ "$MODE" = "all" ]; then
  remove_one waypoint
  remove_one endpoint
else
  if [ "$MODE" != "waypoint" ]; then MODE=endpoint; fi
  remove_one "$MODE"
  # Nudge if the OTHER mode is also installed — the usual "removed the wrong one" trap.
  if [ "$MODE" = "waypoint" ]; then OTHER=endpoint; ONAME=cerebro-agent; OLABEL=com.cerebro.agent
  else OTHER=waypoint; ONAME=cerebro-waypoint; OLABEL=com.cerebro.waypoint; fi
  if [ -e /usr/local/bin/$ONAME ] || [ -e /etc/systemd/system/$ONAME.service ] || [ -e /Library/LaunchDaemons/$OLABEL.plist ]; then
    echo "Note: the $OTHER agent is also installed on this box. Remove it with CEREBRO_MODE=$OTHER (or CEREBRO_MODE=all)."
  fi
fi

exit $UNINSTALL_INCOMPLETE
`;
}

export function uninstallPs1(): string {
  return `# Cerebro Fabric agent / Waypoint uninstaller (Windows). Run in an elevated PowerShell.
# Set $env:CEREBRO_MODE='waypoint' to remove a Waypoint; default removes the endpoint agent.
$ErrorActionPreference = 'SilentlyContinue'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  throw 'Please run this in an elevated (Administrator) PowerShell.'
}

$mode = if ($env:CEREBRO_MODE -eq 'waypoint') { 'waypoint' } else { 'endpoint' }
$svc  = if ($mode -eq 'waypoint') { 'CerebroWaypoint' } else { 'CerebroAgent' }
$name = if ($mode -eq 'waypoint') { 'CerebroWaypoint' } else { 'CerebroAgent' }

sc.exe stop $svc | Out-Null
sc.exe delete $svc | Out-Null
Remove-Item -Recurse -Force (Join-Path $env:ProgramData $name)
Write-Host "$svc removed."
`;
}

export function installPs1(): string {
  return `# Cerebro Fabric agent / Waypoint installer (Windows). See docs/fabric-waypoints.md.
$ErrorActionPreference = 'Stop'

if (-not $env:CEREBRO_URL) { throw 'Set $env:CEREBRO_URL, e.g. https://cerebro.example' }
if (-not $env:ENROLL)      { throw 'Set $env:ENROLL to the one-time enrollment token' }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  throw 'Please run this in an elevated (Administrator) PowerShell.'
}

$mode = if ($env:CEREBRO_MODE -eq 'waypoint') { 'waypoint' } else { 'endpoint' }
$svc  = if ($mode -eq 'waypoint') { 'CerebroWaypoint' } else { 'CerebroAgent' }
$name = if ($mode -eq 'waypoint') { 'CerebroWaypoint' } else { 'CerebroAgent' }
$display = if ($mode -eq 'waypoint') { 'Cerebro Waypoint' } else { 'Cerebro Fabric Agent' }

$dir = Join-Path $env:ProgramData $name
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$bin = Join-Path $dir 'cerebro-agent.exe'

# On a re-install the exe is locked by the running service — stop it first so the
# download can overwrite it, otherwise Invoke-WebRequest fails with a sharing violation.
$existing = Get-Service -Name $svc -ErrorAction SilentlyContinue
if ($existing) { Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue }

Write-Host "Downloading cerebro-agent (windows/amd64) for $display..."
$tmp = "$bin.new"
Invoke-WebRequest -UseBasicParsing -Uri "$($env:CEREBRO_URL)/api/fabric/agent/binary?os=windows&arch=amd64" -OutFile $tmp
Move-Item -Force -Path $tmp -Destination $bin

# Config is read from ProgramData\\$name next to the exe.
$cfg = Join-Path $dir 'config.env'
"CEREBRO_URL=$($env:CEREBRO_URL)\`nENROLL=$($env:ENROLL)\`nCEREBRO_MODE=$mode" | Set-Content -Path $cfg -Encoding ASCII

# Register the service if new; a re-install just reuses the existing one.
if (-not $existing) {
  sc.exe create $svc binPath= "\`"$bin\`" --mode $mode" start= auto DisplayName= "$display" | Out-Null
  sc.exe description $svc "$display — outbound remote-access tunnel" | Out-Null
  # Restart on unexpected exit — this is also how a self-update relaunches on the new binary.
  sc.exe failure $svc reset= 86400 actions= restart/5000 | Out-Null
}

# The Windows service's stderr goes nowhere, so the agent tees its log to
# ProgramData\\$name\\agent.log — clear it for a clean-slate connect check.
$log = Join-Path $dir 'agent.log'
if (Test-Path $log) { Clear-Content -Path $log -ErrorAction SilentlyContinue }
sc.exe start $svc | Out-Null

# --- Post-install validation: poll the agent log (~20s) for a connect result. ---
Write-Host "Waiting for $display to connect to Cerebro..."
$ok = $false; $refused = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $log) {
    $txt = (Get-Content -Path $log -Tail 200 -ErrorAction SilentlyContinue) -join "\`n"
    if ($txt -match 'connected to') { $ok = $true; break }
    if ($txt -match 'credential refused|enrollment failed|enroll rejected|removed in Cerebro|410 Gone') { $refused = $true; break }
  }
}
if ($ok) {
  Write-Host "OK: $display connected to Cerebro."
} else {
  if ($refused) {
    Write-Warning "$display started but Cerebro REFUSED it — likely a stale enrollment on this box, or the agent was removed in Cerebro."
  } else {
    Write-Warning "$display started but did not confirm a connection within 20s."
  }
  Write-Host 'Recent logs:'
  if (Test-Path $log) { Get-Content -Path $log -Tail 12 | ForEach-Object { "    $_" } }
  Write-Host 'To re-enroll cleanly, remove it and re-run with a NEW token from Cerebro:'
  Write-Host "    sc.exe stop $svc; sc.exe delete $svc; Remove-Item -Recurse -Force '$dir'"
  exit 1
}
`;
}
