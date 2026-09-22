#!/bin/sh
# Cerebro Remote Browser entrypoint. Starts a virtual display + VNC server, then
# launches Chromium at START_URL, proxied through CHROME_PROXY (the per-session
# SOCKS5 bridge that rides the Waypoint tunnel). See docs/fabric-waypoints.md.
set -eu

GEOMETRY="${GEOMETRY:-1280x800}"
START_URL="${START_URL:-about:blank}"
WIN_SIZE="$(echo "$GEOMETRY" | sed 's/x/,/')"
export DISPLAY=:0

# Virtual framebuffer.
Xvfb :0 -screen 0 "${GEOMETRY}x24" -nolisten tcp &
# Wait for the display socket.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -e /tmp/.X11-unix/X0 ] && break
  sleep 0.3
done

# VNC server on :5900. The container shares a Docker network with other services,
# so a per-session password (VNC_PASSWORD, handed only to the operator's noVNC
# client via the authenticated ticket) keeps a co-resident container from attaching
# to the live browser. Falls back to no-auth only if unset (older callers).
if [ -n "${VNC_PASSWORD:-}" ]; then
  x11vnc -display :0 -forever -shared -passwd "$VNC_PASSWORD" -rfbport 5900 -bg -quiet -noxdamage -ncache 0
else
  x11vnc -display :0 -forever -shared -nopw -rfbport 5900 -bg -quiet -noxdamage -ncache 0
fi

PROXY_ARG=""
[ -n "${CHROME_PROXY:-}" ] && PROXY_ARG="--proxy-server=${CHROME_PROXY}"

# Optionally accept invalid TLS certs (self-signed internal sites, e.g. a Proxmox
# host). --test-type suppresses the "unsupported flag" warning bar. Word-splits
# into two args on purpose.
CERT_ARG=""
[ -n "${IGNORE_CERT_ERRORS:-}" ] && CERT_ARG="--ignore-certificate-errors --test-type"

# --disable-dev-shm-usage guards against small /dev/shm; --no-sandbox is required
# without extra caps. <-loopback> forces even localhost through the proxy so a
# page can't reach the container itself. Chromium's SOCKS5 does remote DNS.
exec chromium \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --disable-infobars \
  --disable-features=Translate \
  --user-data-dir=/tmp/chrome-profile \
  --window-position=0,0 \
  --window-size="${WIN_SIZE}" \
  --start-maximized \
  ${PROXY_ARG} \
  ${CERT_ARG} \
  --proxy-bypass-list="<-loopback>" \
  --kiosk \
  "${START_URL}"
