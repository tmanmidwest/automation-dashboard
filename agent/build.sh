#!/bin/sh
# Cross-compile the Cerebro Fabric agent for the three supported targets into a
# dist directory. Copy the outputs to the server's FABRIC_AGENT_DIST_DIR (default
# /app/agent-dist) so /api/fabric/agent/binary can serve them to installers.
#
#   ./build.sh [outdir]     # defaults to ./dist
set -eu

OUT="${1:-dist}"
mkdir -p "$OUT"

build() {
  goos="$1"; goarch="$2"; name="$3"
  echo "building $name ($goos/$goarch)..."
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "-s -w" -o "$OUT/$name" .
}

build linux   amd64 cerebro-agent-linux-amd64
build linux   arm64 cerebro-agent-linux-arm64
build windows amd64 cerebro-agent-windows-amd64.exe

echo "done -> $OUT"
