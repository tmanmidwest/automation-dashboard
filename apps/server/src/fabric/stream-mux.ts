import type { Logger } from '@nestjs/common';

/**
 * A single tunnelled TCP stream on the broker side. Bytes written here are
 * framed and sent to the agent; bytes arriving from the agent surface via
 * `onData`. The consumer (a probe, or a browser session relay in Phase 3) wires
 * `onData` / `onClose` and calls `write` / `close`.
 */
export class TunnelStream {
  closed = false;

  private _onClose?: () => void;
  private closedBeforeHandler = false;
  private _onData?: (data: Buffer) => void;
  /**
   * Bytes that arrived before a consumer attached `onData`. Server-speaks-first
   * protocols (VNC/RFB, SSH banners) emit their opening bytes the instant the
   * agent dials the target — which can land while the relay is still awaiting
   * (e.g. writing the session row) between `openStream` and wiring `onData`.
   * Buffer them here and flush in order the moment a handler is set, so the
   * opening banner is never lost.
   */
  private preBuffer: Buffer[] = [];

  constructor(
    readonly id: number,
    private readonly mux: StreamMux,
  ) {}

  get onData(): ((data: Buffer) => void) | undefined {
    return this._onData;
  }

  set onData(fn: ((data: Buffer) => void) | undefined) {
    this._onData = fn;
    if (fn && this.preBuffer.length) {
      const queued = this.preBuffer;
      this.preBuffer = [];
      for (const b of queued) fn(b);
    }
  }

  get onClose(): (() => void) | undefined {
    return this._onClose;
  }

  set onClose(fn: (() => void) | undefined) {
    this._onClose = fn;
    // If the peer already closed before a handler was attached, fire it now so
    // the relay tears down instead of hanging.
    if (fn && this.closedBeforeHandler) {
      this.closedBeforeHandler = false;
      fn();
    }
  }

  write(data: Buffer): void {
    if (!this.closed) this.mux.sendData(this.id, data);
  }

  /** Close locally and tell the agent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.mux.closeLocal(this.id, true);
  }

  /** internal — the peer (agent) closed or errored the stream. */
  peerClosed(): void {
    if (this.closed) return;
    this.closed = true;
    if (this._onClose) this._onClose();
    else this.closedBeforeHandler = true;
  }

  /** internal — deliver inbound bytes to the consumer, buffering until one attaches. */
  deliver(data: Buffer): void {
    if (this._onData) this._onData(data);
    else this.preBuffer.push(data);
  }
}

interface Pending {
  resolve: (s: TunnelStream) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Per-connection stream multiplexer. Owns streamId allocation and routes stream
 * lifecycle (JSON control frames) + data (binary frames) between the agent
 * socket and the logical {@link TunnelStream}s. One instance per live agent
 * connection; disposed when the socket drops. Phase 2 opens streams broker→agent
 * only, so the broker owns the id space.
 */
export class StreamMux {
  private readonly streams = new Map<number, TunnelStream>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;

  constructor(
    private readonly sendControl: (frame: unknown) => void,
    private readonly sendBinary: (buf: Buffer) => void,
    private readonly logger: Logger,
  ) {}

  /** Ask the agent to dial host:port and resolve once the stream is live. */
  openStream(host: string, port: number, timeoutMs = 10_000): Promise<TunnelStream> {
    if (this.disposed) return Promise.reject(new Error('agent disconnected'));
    const streamId = this.nextId++;
    if (this.nextId > 0xffffffff) this.nextId = 1;
    return new Promise<TunnelStream>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(streamId);
        this.sendControl({ t: 'close-stream', streamId });
        reject(new Error('tunnel open timed out'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(streamId, { resolve, reject, timer });
      this.sendControl({ t: 'open-stream', streamId, host, port });
    });
  }

  /** Route a stream-lifecycle control frame from the agent. */
  handleControl(frame: { t: string; streamId?: number; error?: string }): void {
    const id = frame.streamId;
    if (typeof id !== 'number') return;

    if (frame.t === 'stream-opened') {
      const p = this.pending.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(id);
      const s = new TunnelStream(id, this);
      this.streams.set(id, s);
      p.resolve(s);
    } else if (frame.t === 'stream-error') {
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error(frame.error || 'tunnel open failed'));
        return;
      }
      const s = this.streams.get(id);
      this.streams.delete(id);
      s?.peerClosed();
    } else if (frame.t === 'close-stream') {
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error('tunnel closed by agent'));
      }
      const s = this.streams.get(id);
      this.streams.delete(id);
      s?.peerClosed();
    }
  }

  /** Route inbound tunnel bytes (already stripped of the streamId header). */
  handleData(streamId: number, payload: Buffer): void {
    this.streams.get(streamId)?.deliver(payload);
  }

  /** internal — frame + send outbound bytes for a stream. */
  sendData(streamId: number, payload: Buffer): void {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(streamId >>> 0, 0);
    this.sendBinary(Buffer.concat([header, payload]));
  }

  /** internal — local side closed; drop state and (optionally) notify the agent. */
  closeLocal(streamId: number, notifyPeer: boolean): void {
    this.streams.delete(streamId);
    if (notifyPeer) this.sendControl({ t: 'close-stream', streamId });
  }

  /** Tear everything down when the agent connection drops. */
  dispose(): void {
    this.disposed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('agent disconnected'));
    }
    this.pending.clear();
    for (const s of this.streams.values()) s.peerClosed();
    this.streams.clear();
  }
}
