#!/bin/sh
# Cross-compile the cerebro CLI into a dist directory. Copy the outputs to the
# server's FABRIC_CLI_DIST_DIR (default /app/cli-dist) so /api/fabric/cli/binary
# can serve them.
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

build linux   amd64 cerebro-linux-amd64
build linux   arm64 cerebro-linux-arm64
build darwin  amd64 cerebro-darwin-amd64
build darwin  arm64 cerebro-darwin-arm64
build windows amd64 cerebro-windows-amd64.exe

echo "done -> $OUT"
