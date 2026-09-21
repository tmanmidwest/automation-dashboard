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

echo "Downloading cerebro-agent ($OS/$GOARCH) for $DISPLAY..."
curl -fsSL "\${CEREBRO_URL}/api/fabric/agent/binary?os=\${OS}&arch=\${GOARCH}" -o "$BIN"
chmod 0755 "$BIN"

mkdir -p "$CFG"
chmod 0700 "$CFG"
cat > "$CFG/config.env" <<EOF
CEREBRO_URL=\${CEREBRO_URL}
ENROLL=\${ENROLL}
CEREBRO_MODE=\${MODE}
EOF
chmod 0600 "$CFG/config.env"

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
  launchctl bootstrap system "$PLIST"
  echo "$DISPLAY installed and started (launchd). It will appear in Cerebro shortly."
  exit 0
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
systemctl enable --now $NAME.service
echo "$DISPLAY installed and started. It will appear in Cerebro shortly."
`;
}

export function uninstallSh(): string {
  return `#!/bin/sh
# Cerebro Fabric agent / Waypoint uninstaller (Linux + macOS — auto-detected).
# Set CEREBRO_MODE=waypoint to remove a Waypoint; default removes the endpoint agent.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

MODE="\${CEREBRO_MODE:-endpoint}"
if [ "$MODE" = "waypoint" ]; then
  NAME=cerebro-waypoint
  LABEL=com.cerebro.waypoint
else
  NAME=cerebro-agent
  LABEL=com.cerebro.agent
fi

if [ "$(uname)" = "Darwin" ]; then
  PLIST=/Library/LaunchDaemons/$LABEL.plist
  launchctl bootout system "$PLIST" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST" /usr/local/bin/$NAME
  rm -rf /etc/$NAME
else
  systemctl disable --now $NAME 2>/dev/null || true
  rm -f /etc/systemd/system/$NAME.service /usr/local/bin/$NAME
  rm -rf /etc/$NAME /var/lib/$NAME
  systemctl daemon-reload 2>/dev/null || true
fi
echo "$NAME removed."
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

Write-Host "Downloading cerebro-agent (windows/amd64) for $display..."
Invoke-WebRequest -UseBasicParsing -Uri "$($env:CEREBRO_URL)/api/fabric/agent/binary?os=windows&arch=amd64" -OutFile $bin

# Config is read from ProgramData\\$name next to the exe.
$cfg = Join-Path $dir 'config.env'
"CEREBRO_URL=$($env:CEREBRO_URL)\`nENROLL=$($env:ENROLL)\`nCEREBRO_MODE=$mode" | Set-Content -Path $cfg -Encoding ASCII

# Register + start a Windows service. --mode makes the agent use the per-mode dir.
sc.exe create $svc binPath= "\`"$bin\`" --mode $mode" start= auto DisplayName= "$display" | Out-Null
sc.exe description $svc "$display — outbound remote-access tunnel" | Out-Null
# Restart on unexpected exit — this is also how a self-update relaunches on the new binary.
sc.exe failure $svc reset= 86400 actions= restart/5000 | Out-Null
sc.exe start $svc | Out-Null
Write-Host "$display installed and started. It will appear in Cerebro shortly."
`;
}
