import { Duplex } from 'stream';
import type { TunnelStream } from './stream-mux';

/**
 * Adapts a {@link TunnelStream} into a Node Duplex so libraries that expect a
 * socket — notably ssh2's `sock` option — can run their protocol over the Fabric
 * tunnel instead of a real TCP connection. Bytes written go to the agent; bytes
 * from the agent are pushed to readers.
 *
 * Interactive-shell scale, so it does not (yet) honour push() backpressure — a
 * hardening item if bulk transfers (scp) ever ride this.
 */
export class TunnelSocket extends Duplex {
  constructor(private readonly stream: TunnelStream) {
    super();
    stream.onData = (buf: Buffer) => {
      this.push(buf);
    };
    stream.onClose = () => {
      this.push(null);
    };
  }

  _read(): void {
    // Inbound bytes are pushed as they arrive from the tunnel.
  }

  _write(chunk: unknown, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    try {
      this.stream.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }

  _final(cb: () => void): void {
    this.stream.close();
    cb();
  }

  _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.stream.close();
    cb(err);
  }
}
