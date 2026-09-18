declare module 'guacamole-lite' {
  import type { IncomingMessage, Server as HttpServer } from 'http';
  import type { Duplex } from 'stream';

  interface WebsocketOptions {
    server?: HttpServer;
    path?: string;
    noServer?: boolean;
    port?: number | null;
  }

  interface WsUpgradeServer {
    handleUpgrade(
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      cb: (ws: unknown, req: IncomingMessage) => void,
    ): void;
    emit(event: string, ...args: unknown[]): boolean;
  }
  interface GuacdOptions {
    host?: string;
    port?: number;
  }
  interface ClientOptions {
    crypt: { cipher: string; key: string };
    log?: { level?: string };
    connectionDefaultSettings?: Record<string, Record<string, unknown>>;
    maxInactivityTime?: number;
  }
  interface Callbacks {
    processConnectionSettings?: (
      settings: { connection: { type: string; settings: Record<string, unknown> } },
      callback: (err: unknown, settings?: unknown) => void,
    ) => void;
  }

  class GuacamoleLiteServer {
    constructor(
      websocketOptions: WebsocketOptions,
      guacdOptions: GuacdOptions,
      clientOptions: ClientOptions,
      callbacks?: Callbacks,
    );
    webSocketServer: WsUpgradeServer;
    on(event: string, listener: (...args: unknown[]) => void): void;
    close(): void;
  }

  export = GuacamoleLiteServer;
}
