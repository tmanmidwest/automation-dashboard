declare module 'guacamole-lite' {
  import type { Server as HttpServer } from 'http';

  interface WebsocketOptions {
    server?: HttpServer;
    path?: string;
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
    on(event: string, listener: (...args: unknown[]) => void): void;
    close(): void;
  }

  export = GuacamoleLiteServer;
}
