import { WebSocket } from 'ws';
import type { HaAuth } from './ha-api';

/** A Home Assistant config entry (an installed integration instance). */
export interface HaConfigEntry {
  entry_id: string;
  domain: string;
  title: string;
  /** 'loaded' | 'setup_error' | 'setup_retry' | 'migration_error' | 'not_loaded' | 'failed_unload' | 'setup_in_progress' */
  state: string;
  source?: string;
  disabled_by?: string | null;
  reason?: string | null;
}

export class HaWsError extends Error {}

/** Turn a base URL into the HA WebSocket URL (http→ws, https→wss, default wss). */
function wsUrl(baseUrl: string): string {
  const u = baseUrl.replace(/\/$/, '');
  if (u.startsWith('https://')) return `wss://${u.slice(8)}/api/websocket`;
  if (u.startsWith('http://')) return `ws://${u.slice(7)}/api/websocket`;
  return `wss://${u}/api/websocket`;
}

function mapWsError(err: NodeJS.ErrnoException): string {
  if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'SELF_SIGNED_CERT_IN_CHAIN')
    return 'TLS certificate is self-signed. Disable "Verify TLS certificate" for this server, or install a trusted cert.';
  if (err.code === 'ECONNREFUSED') return 'Connection refused — check the base URL and port.';
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.code === 'EAI_NODATA')
    return 'Host not found — check the base URL and that its DNS name resolves.';
  return err.message || 'Home Assistant WebSocket error.';
}

/**
 * One authenticated Home Assistant WebSocket connection for request/response
 * commands (config entries, registries, reload). Not a live subscription — open
 * it, run a few commands, then close. See withHaWs for the managed form.
 */
export class HaWsConn {
  private ws!: WebSocket;
  private nextId = 1;
  private ready = false;
  private keepAlive?: ReturnType<typeof setInterval>;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  /** Called for each subscription event (see subscribe). */
  onEvent?: (event: unknown) => void;
  /** Called once if the socket closes after it was connected (upstream drop). */
  onClose?: () => void;

  constructor(private readonly auth: HaAuth) {}

  /** Connect and complete the auth handshake (resolves on auth_ok). */
  connect(timeoutMs = 15000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const url = wsUrl(this.auth.baseUrl);
      const ws = new WebSocket(url, url.startsWith('wss:') ? { rejectUnauthorized: this.auth.verifyTls } : undefined);
      this.ws = ws;
      const timer = setTimeout(() => {
        finish(() => reject(new HaWsError('Timed out connecting to the Home Assistant WebSocket.')));
        ws.terminate();
      }, timeoutMs);

      ws.on('message', (raw) => {
        let msg: { type?: string; id?: number; success?: boolean; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === 'auth_required') {
          ws.send(JSON.stringify({ type: 'auth', access_token: this.auth.token }));
          return;
        }
        if (msg.type === 'auth_ok') {
          this.ready = true;
          finish(resolve);
          return;
        }
        if (msg.type === 'auth_invalid') {
          finish(() => reject(new HaWsError('Authentication failed — the access token was rejected.')));
          ws.close();
          return;
        }
        if (msg.type === 'event') {
          this.onEvent?.((msg as { event?: unknown }).event);
          return;
        }
        if (msg.type === 'result' && typeof msg.id === 'number') {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          if (msg.success) p.resolve(msg.result);
          else p.reject(new HaWsError(msg.error?.message || 'Home Assistant rejected the request.'));
        }
        // 'pong' and anything else are ignored.
      });
      ws.on('error', (err: NodeJS.ErrnoException) => {
        finish(() => reject(new HaWsError(mapWsError(err))));
        this.failAll(new HaWsError(mapWsError(err)));
      });
      ws.on('close', () => {
        const wasReady = this.ready;
        finish(() => reject(new HaWsError('The Home Assistant WebSocket closed before authenticating.')));
        this.failAll(new HaWsError('WebSocket closed.'));
        if (wasReady) this.onClose?.();
      });
    });
  }

  /** Subscribe to an event type (e.g. 'state_changed'); events arrive via onEvent. */
  async subscribe(eventType: string): Promise<void> {
    await this.command({ type: 'subscribe_events', event_type: eventType });
  }

  /** Send periodic pings so idle proxies/NAT don't drop a long-lived subscription. */
  startKeepAlive(ms = 30_000): void {
    this.keepAlive = setInterval(() => {
      try {
        this.ws.send(JSON.stringify({ type: 'ping', id: this.nextId++ }));
      } catch {
        /* socket gone; close handler will fire */
      }
    }, ms);
  }

  /** Send a command and resolve with its `result`. */
  command<T>(msg: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
    if (!this.ready) return Promise.reject(new HaWsError('WebSocket is not authenticated.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HaWsError('Timed out waiting for a Home Assistant WebSocket response.'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ ...msg, id }));
    });
  }

  close(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.onClose = undefined; // deliberate close — don't fire the drop callback
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }

  private failAll(err: unknown): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

/** Open an authenticated HA WebSocket, run `fn`, then always close it. */
export async function withHaWs<T>(auth: HaAuth, fn: (conn: HaWsConn) => Promise<T>): Promise<T> {
  const conn = new HaWsConn(auth);
  await conn.connect();
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}

// ── Registries (for area / room grouping) ─────────────────────
interface HaArea {
  area_id: string;
  name: string;
}
interface HaDeviceReg {
  id: string;
  area_id: string | null;
}
interface HaEntityReg {
  entity_id: string;
  area_id: string | null;
  device_id: string | null;
}

/**
 * Resolve each entity to its area (room) name via the area/device/entity registries.
 * An entity's area is its own `area_id` if set, else its device's `area_id`. Entities
 * with no registry entry (e.g. some YAML/template entities) simply have no area.
 */
export async function fetchEntityAreaMap(auth: HaAuth): Promise<Map<string, string>> {
  return withHaWs(auth, async (conn) => {
    const [areas, devices, entities] = await Promise.all([
      conn.command<HaArea[]>({ type: 'config/area_registry/list' }),
      conn.command<HaDeviceReg[]>({ type: 'config/device_registry/list' }),
      conn.command<HaEntityReg[]>({ type: 'config/entity_registry/list' }),
    ]);
    const areaName = new Map(areas.map((a) => [a.area_id, a.name]));
    const deviceArea = new Map(devices.map((d) => [d.id, d.area_id]));
    const map = new Map<string, string>();
    for (const e of entities) {
      const areaId = e.area_id ?? (e.device_id ? deviceArea.get(e.device_id) ?? null : null);
      const name = areaId ? areaName.get(areaId) : undefined;
      if (name) map.set(e.entity_id, name);
    }
    return map;
  });
}
