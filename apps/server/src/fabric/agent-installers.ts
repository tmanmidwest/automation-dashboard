/**
 * Bootstrap installers served (unauthenticated) at /api/fabric/install.sh and
 * install.ps1. They are generic — the enrollment token is passed in the
 * environment by the copy-paste one-liner, never baked into the script — so the
 * scripts themselves are safe to serve publicly.
 *
 * Each downloads the matching agent binary from Cerebro, drops a config file
 * carrying CEREBRO_URL + the one-time ENROLL token, and installs a service. On
 * first start the agent exchanges ENROLL for its long-lived credential.
 */

export function installSh(): string {
  return `#!/bin/sh
# Cerebro Fabric agent installer (Linux). See docs/fabric-remote-access.md.
set -eu

: "\${CEREBRO_URL:?Set CEREBRO_URL, e.g. https://cerebro.example}"
: "\${ENROLL:?Set ENROLL to the one-time enrollment token}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) GOARCH=amd64 ;;
  aarch64|arm64) GOARCH=arm64 ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

BIN=/usr/local/bin/cerebro-agent
CFG=/etc/cerebro-agent

echo "Downloading cerebro-agent (linux/$GOARCH)..."
curl -fsSL "\${CEREBRO_URL}/api/fabric/agent/binary?os=linux&arch=\${GOARCH}" -o "$BIN"
chmod 0755 "$BIN"

mkdir -p "$CFG"
chmod 0700 "$CFG"
cat > "$CFG/config.env" <<EOF
CEREBRO_URL=\${CEREBRO_URL}
ENROLL=\${ENROLL}
EOF
chmod 0600 "$CFG/config.env"

cat > /etc/systemd/system/cerebro-agent.service <<EOF
[Unit]
Description=Cerebro Fabric Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/cerebro-agent/config.env
ExecStart=/usr/local/bin/cerebro-agent
Restart=always
RestartSec=5
DynamicUser=yes
StateDirectory=cerebro-agent

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now cerebro-agent.service
echo "cerebro-agent installed and started. It will appear in Cerebro shortly."
`;
}

export function installPs1(): string {
  return `# Cerebro Fabric agent installer (Windows). See docs/fabric-remote-access.md.
$ErrorActionPreference = 'Stop'

if (-not $env:CEREBRO_URL) { throw 'Set $env:CEREBRO_URL, e.g. https://cerebro.example' }
if (-not $env:ENROLL)      { throw 'Set $env:ENROLL to the one-time enrollment token' }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  throw 'Please run this in an elevated (Administrator) PowerShell.'
}

$dir = Join-Path $env:ProgramData 'CerebroAgent'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$bin = Join-Path $dir 'cerebro-agent.exe'

Write-Host 'Downloading cerebro-agent (windows/amd64)...'
Invoke-WebRequest -UseBasicParsing -Uri "$($env:CEREBRO_URL)/api/fabric/agent/binary?os=windows&arch=amd64" -OutFile $bin

# Config is read from the service environment (set below via the registry).
$cfg = Join-Path $dir 'config.env'
"CEREBRO_URL=$($env:CEREBRO_URL)\`nENROLL=$($env:ENROLL)" | Set-Content -Path $cfg -Encoding ASCII

# Register + start a Windows service. The agent reads config.env next to its exe.
sc.exe create CerebroAgent binPath= "\`"$bin\`"" start= auto DisplayName= "Cerebro Fabric Agent" | Out-Null
sc.exe description CerebroAgent "Cerebro Fabric Agent — outbound remote-access tunnel" | Out-Null
sc.exe start CerebroAgent | Out-Null
Write-Host 'cerebro-agent installed and started. It will appear in Cerebro shortly.'
`;
}
