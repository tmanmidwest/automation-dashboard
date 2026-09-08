import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { WebSocket } from 'ws';

export interface JellyfinAuth {
  /** Base URL of the server, e.g. http://10.0.0.5:8096 */
  baseUrl: string;
  /** API key (Dashboard → API Keys), sent as X-Emby-Token. */
  apiKey: string;
  /** Accept a self-signed HTTPS certificate. */
  insecureSkipVerify?: boolean;
}

export class JellyfinApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** GET /System/Info */
export interface JfSystemInfo {
  ServerName?: string;
  Version?: string;
  OperatingSystem?: string;
  Id?: string;
}

/** GET /Sessions — one active client session. */
export interface JfSession {
  Id: string;
  UserName?: string;
  Client?: string;
  DeviceName?: string;
  DeviceId?: string;
  LastActivityDate?: string;
  NowPlayingItem?: {
    Name?: string;
    Type?: string; // Movie | Episode | Audio | …
    SeriesName?: string;
    RunTimeTicks?: number;
  };
  PlayState?: {
    IsPaused?: boolean;
    PositionTicks?: number;
    PlayMethod?: string; // DirectPlay | DirectStream | Transcode
  };
  TranscodingInfo?: {
    Bitrate?: number;
    VideoCodec?: string;
    AudioCodec?: string;
    Container?: string;
    CompletionPercentage?: number;
    TranscodeReasons?: string[];
  };
}

/** GET /Users */
export interface JfUser {
  Id: string;
  Name?: string;
  LastActivityDate?: string;
  LastLoginDate?: string;
  Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean };
}

/** GET /Library/VirtualFolders */
export interface JfVirtualFolder {
  Name?: string;
  CollectionType?: string; // movies | tvshows | music | …
  ItemId?: string;
  Locations?: string[];
}

/** GET /Items/Counts */
export interface JfItemCounts {
  MovieCount?: number;
  SeriesCount?: number;
  EpisodeCount?: number;
  AlbumCount?: number;
  SongCount?: number;
  ItemCount?: number;
  BoxSetCount?: number;
}

/** GET /ScheduledTasks */
export interface JfScheduledTask {
  Id: string;
  Name?: string;
  State?: string; // Idle | Running | Cancelling
  CurrentProgressPercentage?: number;
  Category?: string;
  LastExecutionResult?: { Status?: string; StartTimeUtc?: string; EndTimeUtc?: string; ErrorMessage?: string };
}

/**
 * Minimal Jellyfin REST client — dependency-free HTTP/HTTPS, API-key (X-Emby-Token)
 * auth against a user-supplied base URL. See docs/connectors/jellyfin.md.
 */
export class JellyfinApi {
  constructor(private readonly auth: JellyfinAuth) {}

  systemInfo() { return this.get<JfSystemInfo>('/System/Info'); }
  sessions() { return this.get<JfSession[]>('/Sessions'); }
  users() { return this.get<JfUser[]>('/Users'); }
  virtualFolders() { return this.get<JfVirtualFolder[]>('/Library/VirtualFolders'); }
  itemCounts() { return this.get<JfItemCounts>('/Items/Counts'); }
  scheduledTasks() { return this.get<JfScheduledTask[]>('/ScheduledTasks'); }

  // ── Controls (Phase 2) ────────────────────────────────────────────
  /** Playback command on a session: Pause | Unpause | Stop | PlayPause | Seek | … */
  sessionCommand(sessionId: string, command: string) {
    return this.request<void>('POST', `/Sessions/${encodeURIComponent(sessionId)}/Playing/${encodeURIComponent(command)}`);
  }
  /** Pop a message on a client. */
  sendMessage(sessionId: string, text: string, header = 'Cerebro') {
    return this.request<void>('POST', `/Sessions/${encodeURIComponent(sessionId)}/Message`, { Text: text, Header: header, TimeoutMs: 5000 });
  }
  /** Trigger a library (or item) rescan. */
  refreshItem(itemId: string) {
    return this.request<void>('POST', `/Items/${encodeURIComponent(itemId)}/Refresh?Recursive=true&MetadataRefreshMode=Default&ImageRefreshMode=Default`);
  }
  /** Start a scheduled task now. */
  runTask(taskId: string) {
    return this.request<void>('POST', `/ScheduledTasks/Running/${encodeURIComponent(taskId)}`);
  }

  /**
   * Open Jellyfin's WebSocket and stream the live session list. Subscribes with
   * SessionsStart, answers keep-alives, and calls onSessions on each Sessions push.
   * Resolves when the caller aborts; rejects if the socket closes/errors otherwise.
   */
  watchSessions(onSessions: (sessions: JfSession[]) => void, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.wsUrl(), { rejectUnauthorized: !this.auth.insecureSkipVerify, handshakeTimeout: 15000 });
      } catch (err) {
        return reject(err instanceof Error ? err : new JellyfinApiError('Failed to open Jellyfin socket.'));
      }
      const onAbort = () => { try { ws.close(); } catch { /* ignore */ } };
      signal.addEventListener('abort', onAbort);
      ws.on('open', () => {
        // "startPos,intervalMs" — push the session list every 1.5s.
        ws.send(JSON.stringify({ MessageType: 'SessionsStart', Data: '0,1500' }));
      });
      ws.on('message', (buf: Buffer) => {
        let m: { MessageType?: string; Data?: unknown };
        try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
        if (m.MessageType === 'Sessions' && Array.isArray(m.Data)) onSessions(m.Data as JfSession[]);
        else if (m.MessageType === 'ForceKeepAlive' || m.MessageType === 'KeepAlive') {
          try { ws.send(JSON.stringify({ MessageType: 'KeepAlive' })); } catch { /* ignore */ }
        }
      });
      ws.on('close', () => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) resolve();
        else reject(new JellyfinApiError('Jellyfin socket closed.'));
      });
      ws.on('error', (err: Error) => {
        signal.removeEventListener('abort', onAbort);
        reject(new JellyfinApiError(friendly(err)));
      });
    });
  }

  /** ws(s)://host:port/socket?api_key=…&deviceId=cerebro — the live socket. */
  private wsUrl(): string {
    const base = new URL(this.baseUrl());
    const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${base.host}/socket?api_key=${encodeURIComponent(this.auth.apiKey)}&deviceId=cerebro-live`;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let url: URL;
    try {
      url = new URL(path, this.baseUrl());
    } catch {
      return Promise.reject(new JellyfinApiError('Invalid Jellyfin base URL.'));
    }
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const headers: Record<string, string> = {
      'X-Emby-Token': this.auth.apiKey,
      Accept: 'application/json',
    };
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload).toString();
    }

    const options: https.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      timeout: 20000,
      ...(isHttps && this.auth.insecureSkipVerify ? { rejectUnauthorized: false } : {}),
    };

    return new Promise((resolve, reject) => {
      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status === 401 || status === 403) {
            return reject(new JellyfinApiError('Authentication failed — check the API key.', status));
          }
          if (status < 200 || status >= 300) {
            return reject(new JellyfinApiError(`Jellyfin returned HTTP ${status}: ${text.slice(0, 200)}`, status));
          }
          if (!text) return resolve(undefined as T);
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new JellyfinApiError('Could not parse the Jellyfin response as JSON.', status));
          }
        });
      });
      req.on('timeout', () => req.destroy(new JellyfinApiError('Jellyfin request timed out.')));
      req.on('error', (err) => reject(new JellyfinApiError(friendly(err))));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  private baseUrl(): string {
    const b = (this.auth.baseUrl || '').trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(b) ? `${b}/` : `http://${b}/`;
  }
}

function friendly(err: Error & { code?: string }): string {
  if (err.code === 'ECONNREFUSED') return 'Connection refused — is Jellyfin running and the URL/port correct?';
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return 'Host could not be resolved — check the base URL.';
  if (err.code === 'ETIMEDOUT') return 'Connection timed out.';
  return err.message || 'Jellyfin request failed.';
}
