import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { ConnectorConsoleTarget } from '@cerebro/shared';

/**
 * Issues short-lived, one-time tokens that authorize a console WebSocket relay.
 * The browser opens the console over the app session (so it's authenticated),
 * receives a token, then connects the raw WS with ?token=… — which the relay
 * consumes exactly once. Tokens expire quickly since the VNC ticket is short-lived.
 */
@Injectable()
export class ConsoleService {
  private readonly tokens = new Map<string, { target: ConnectorConsoleTarget; expiresAt: number }>();

  issue(target: ConnectorConsoleTarget, ttlMs = 30_000): string {
    const token = randomUUID();
    this.tokens.set(token, { target, expiresAt: Date.now() + ttlMs });
    this.prune();
    return token;
  }

  /** Returns the target and invalidates the token (single use). */
  consume(token: string): ConnectorConsoleTarget | null {
    const entry = this.tokens.get(token);
    this.tokens.delete(token);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry.target;
  }

  private prune() {
    const now = Date.now();
    for (const [t, e] of this.tokens) if (e.expiresAt < now) this.tokens.delete(t);
  }
}
