import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as jwt from 'jsonwebtoken';
import type { Permission } from '@cerebro/shared';
import { SettingsService } from '../settings/settings.service';

/** Vault key holding the HS256 signing secret for OAuth access tokens. */
const JWT_SECRET_KEY = 'oauth:jwtSecret';
/** Access-token lifetime (Phase 3 default). */
const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 60 minutes
/** Machine (client_credentials) tokens: short-lived, and no refresh token. */
export const MACHINE_TOKEN_TTL_SEC = 15 * 60;
/** Resource paths a token's audience may name (RFC 8707), relative to APP_URL. */
export const MCP_RESOURCE_PATH = '/mcp';
export const AGENT_CATALOG_RESOURCE_PATH = '/api/v1/agents';

export interface AccessTokenClaims {
  sub: string; // Cerebro user id, or the client_id for a machine client
  /** 'client' when the subject is a machine OAuth client rather than a user. */
  sub_type?: 'client';
  scope: string; // space-delimited Permission strings
  client_id: string;
  aud?: string; // resource indicator (RFC 8707)
}

/**
 * Issues and validates OAuth access tokens. Access tokens are stateless HS256 JWTs — the
 * resource server (our bearer guard) verifies them locally with no DB round trip. The
 * signing secret lives in the encrypted `Secret` vault and is generated on first use, so
 * it survives restarts and is shared across all app instances that read the same vault.
 */
@Injectable()
export class OAuthTokenService {
  private readonly logger = new Logger(OAuthTokenService.name);
  private secretCache: string | null = null;

  constructor(private readonly settings: SettingsService) {}

  private get issuer(): string | undefined {
    return process.env.APP_URL || undefined;
  }

  private async signingSecret(): Promise<string> {
    if (this.secretCache) return this.secretCache;
    let secret = await this.settings.getSecret(JWT_SECRET_KEY);
    if (!secret) {
      secret = randomBytes(32).toString('base64');
      await this.settings.setSecret(JWT_SECRET_KEY, secret);
      this.logger.log('Generated a new OAuth JWT signing secret.');
    }
    this.secretCache = secret;
    return secret;
  }

  /** Mint a signed access token. Returns the JWT and its lifetime in seconds. */
  async signAccessToken(input: {
    userId: string;
    clientId: string;
    scopes: Permission[];
    resource?: string;
    /** A machine client token: `userId` is then the client_id. */
    machine?: boolean;
    ttlSec?: number;
  }): Promise<{ token: string; expiresInSec: number }> {
    const secret = await this.signingSecret();
    const ttl = input.ttlSec ?? ACCESS_TOKEN_TTL_SEC;
    const payload: AccessTokenClaims = {
      sub: input.userId,
      scope: input.scopes.join(' '),
      client_id: input.clientId,
    };
    if (input.machine) payload.sub_type = 'client';
    if (input.resource) payload.aud = input.resource;

    const token = jwt.sign(payload, secret, {
      algorithm: 'HS256',
      expiresIn: ttl,
      jwtid: randomBytes(12).toString('hex'),
      ...(this.issuer ? { issuer: this.issuer } : {}),
    });
    return { token, expiresInSec: ttl };
  }

  /** The audience for a resource path on this server, or undefined without APP_URL. */
  audienceFor(path: string): string | undefined {
    return this.issuer ? `${this.issuer.replace(/\/$/, '')}${path}` : undefined;
  }

  /**
   * Verify a bearer string as one of our access tokens. Returns the claims, or null if it
   * is not a valid, unexpired token we signed. Never throws.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
    try {
      const secret = await this.signingSecret();
      const decoded = jwt.verify(token, secret, {
        algorithms: ['HS256'],
        ...(this.issuer ? { issuer: this.issuer } : {}),
      });
      if (typeof decoded !== 'object' || !decoded.sub || typeof decoded.sub !== 'string') {
        return null;
      }
      const claims = decoded as jwt.JwtPayload & AccessTokenClaims;
      const aud = typeof claims.aud === 'string' ? claims.aud : undefined;
      // If the token carries a resource audience (RFC 8707), bind it to a resource on THIS
      // server — `<APP_URL>/mcp` or the agent catalog. A token minted for a different
      // resource is rejected. Tokens with no `aud` (no resource requested) are
      // accepted as before, so this doesn't disturb the common flow.
      const known = [MCP_RESOURCE_PATH, AGENT_CATALOG_RESOURCE_PATH].map((p) => this.audienceFor(p));
      if (aud && this.issuer && !known.includes(aud.replace(/\/$/, ''))) {
        return null; // token minted for a different resource
      }
      return {
        sub: claims.sub,
        ...(claims.sub_type === 'client' ? { sub_type: 'client' as const } : {}),
        scope: typeof claims.scope === 'string' ? claims.scope : '',
        client_id: claims.client_id,
        aud,
      };
    } catch {
      return null; // bad signature, expired, wrong issuer, malformed — all "not our token"
    }
  }
}
