# Cerebro Remote Browser (see docs/fabric-waypoints.md).
#
# A headless Chromium behind an Xvfb display, exposed over VNC (x11vnc :5900).
# Cerebro launches ONE ephemeral container of this image per Remote Browser session,
# passing:
#   START_URL     the internal page to open
#   CHROME_PROXY  socks5://<cerebro>:<port>  (rides the Waypoint tunnel)
#   GEOMETRY      e.g. 1280x800
# Chromium does remote DNS over SOCKS5, so internal hostnames resolve on the
# Waypoint, not here. The container has no VNC password — it is only reachable on
# the internal Docker network, and the session is gated by a one-time ticket.
#
# Build:  docker build -t cerebro-remote-browser:latest docker/remote-browser
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      x11vnc \
      ca-certificates \
      fonts-liberation \
      dumb-init \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 5900
ENTRYPOINT ["dumb-init", "--"]
CMD ["/usr/local/bin/entrypoint.sh"]
