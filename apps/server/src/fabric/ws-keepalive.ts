import type { WebSocket } from 'ws';

/**
 * Keep a viewer-facing WebSocket warm with periodic ping frames, and reap it if a
 * pong never comes back.
 *
 * Our ingress (the Cloudflare tunnel in front of cerebro.*) closes proxied
 * WebSockets that go idle for ~100s. A session whose screen is static — a Remote
 * Browser page just sitting there, an idle SSH shell — sends no frames in either
 * direction, so without this it gets cut after ~100s and the operator sees a
 * spurious "connection lost". The ping/pong doubles as half-open detection: a
 * socket whose peer vanished is terminated instead of left frozen.
 *
 * Ping/pong are protocol control frames, independent of application data (and
 * browsers answer them automatically), so this is transparent to whatever is
 * piping over the socket. Default cadence (25s) sits comfortably under the ~100s
 * idle budget while tolerating a missed pong before the next ping reaps it.
 */
export function attachWsKeepalive(ws: WebSocket, intervalMs = 25_000): void {
  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (!alive) {
      // No pong since the last ping — the socket is dead (or wedged). Terminate so
      // the session's own close handlers run and tear everything down.
      try {
        ws.terminate();
      } catch {
        /* noop */
      }
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      /* noop */
    }
  }, intervalMs);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  ws.on('close', stop);
  ws.on('error', stop);
}
