import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Permission, SessionUser } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

/** A resolved bearer principal — a normal SessionUser plus the token it came from. */
export interface TokenPrincipal {
  user: SessionUser;
  tokenId: string;
}

const TOKEN_PREFIX = 'cbro_';
/** Refresh `lastUsedAt` at most this often, to avoid a DB write on every request. */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Validates programmatic API tokens and mints new ones. Tokens are
 * `cbro_<prefix>_<secret>`: `prefix` is a public indexed lookup id, and only the
 * sha256 of `secret` is stored. A resolved token's effective permissions are its
 * granted scopes intersected with the owner's *current* role permissions, so
 * revoking a role permission also narrows every token that user holds.
 */
@Injectable()
export class TokenAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  private hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  /** Generate a fresh token. Returns the plaintext (shown once) and its stored parts. */
  generate(): { plaintext: string; prefix: string; hash: string } {
    const prefix = randomBytes(6).toString('hex'); // 12 hex chars
    const secret = randomBytes(24).toString('base64url'); // ~32 url-safe chars
    return {
      plaintext: `${TOKEN_PREFIX}${prefix}_${secret}`,
      prefix,
      hash: this.hashSecret(secret),
    };
  }

  /**
   * Resolve an `Authorization` header value into a principal, or null if it is not a
   * valid, active bearer token. Never throws for a bad token — the guard decides the
   * response — but treats structural problems and unknown tokens identically.
   */
  async resolve(authHeader: string | undefined): Promise<TokenPrincipal | null> {
    const raw = this.extractBearer(authHeader);
    if (!raw || !raw.startsWith(TOKEN_PREFIX)) return null;

    const body = raw.slice(TOKEN_PREFIX.length);
    const sep = body.indexOf('_');
    if (sep <= 0) return null;
    const prefix = body.slice(0, sep);
    const secret = body.slice(sep + 1);
    if (!prefix || !secret) return null;

    const token = await this.prisma.apiToken.findUnique({ where: { prefix } });
    if (!token) return null;
    if (token.revokedAt) return null;
    if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) return null;
    if (!this.hashMatches(secret, token.hash)) return null;

    const owner = await this.authService.buildSessionUser(token.userId);
    if (!owner) return null; // owner deleted/disabled → token is dead

    // Effective permissions: granted scopes ∩ owner's current role permissions.
    const scopes = token.scopes as Permission[];
    const permissions = owner.permissions.filter((p) => scopes.includes(p));

    await this.touchLastUsed(token.id, token.lastUsedAt);

    return { user: { ...owner, permissions }, tokenId: token.id };
  }

  private extractBearer(authHeader: string | undefined): string | null {
    if (!authHeader) return null;
    const [scheme, value] = authHeader.split(' ');
    if (!value || scheme.toLowerCase() !== 'bearer') return null;
    return value.trim();
  }

  /** Constant-time comparison of sha256(secret) against the stored hash. */
  private hashMatches(secret: string, storedHash: string): boolean {
    const a = Buffer.from(this.hashSecret(secret), 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private async touchLastUsed(id: string, current: Date | null): Promise<void> {
    if (current && Date.now() - current.getTime() < LAST_USED_THROTTLE_MS) return;
    // Best-effort: never fail a request because the usage stamp couldn't be written.
    await this.prisma.apiToken
      .update({ where: { id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }
}
