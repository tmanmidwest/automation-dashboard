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

# VNC server on :5900 (no password — internal network only, ticket-gated relay).
x11vnc -display :0 -forever -shared -nopw -rfbport 5900 -bg -quiet -noxdamage -ncache 0

PROXY_ARG=""
[ -n "${CHROME_PROXY:-}" ] && PROXY_ARG="--proxy-server=${CHROME_PROXY}"

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
  --proxy-bypass-list="<-loopback>" \
  --kiosk \
  "${START_URL}"
