import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { OAuthClient } from '@prisma/client';
import type { Permission } from '@cerebro/shared';
import type { OAuthGrantSummary } from '@cerebro/shared';
import { GRANTABLE_TOKEN_SCOPES } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { OAuthTokenService } from '../auth/oauth-token.service';

/** OAuth error carrying a spec error code. `redirectable` = safe to report via redirect_uri. */
export class OAuthFlowError extends Error {
  constructor(
    readonly code: string,
    readonly description: string,
    readonly redirectable = true,
  ) {
    super(`${code}: ${description}`);
  }
}

const CODE_TTL_MS = 60_000; // 60s authorization-code lifetime
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/**
 * Core OAuth 2.1 authorization-server logic: request validation, PKCE, remembered consent,
 * authorization-code issuance/exchange, and refresh-token rotation. Scopes are the RBAC
 * Permission strings and stay read-only for now. Access tokens are HS256 JWTs (stateless);
 * codes and refresh tokens are stored only as sha256 hashes.
 */
@Injectable()
export class OAuthFlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: OAuthTokenService,
  ) {}

  private sha256(s: string): string {
    return createHash('sha256').update(s).digest('hex');
  }

  private base64urlSha256(s: string): string {
    return createHash('sha256').update(s).digest('base64url');
  }

  // ── Clients ──────────────────────────────────────────────

  async getEnabledClient(clientId: string): Promise<OAuthClient | null> {
    if (!clientId) return null;
    const client = await this.prisma.oAuthClient.findUnique({ where: { clientId } });
    if (!client || client.disabled) return null;
    return client;
  }

  /** Registered loopback URIs (localhost/127.0.0.1/::1) match any port; others match exactly. */
  redirectUriMatches(registered: string[], presented: string): boolean {
    let p: URL;
    try {
      p = new URL(presented);
    } catch {
      return false;
    }
    const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
    return registered.some((r) => {
      if (r === presented) return true;
      let ru: URL;
      try {
        ru = new URL(r);
      } catch {
        return false;
      }
      if (!loopback.has(ru.hostname) || !loopback.has(p.hostname)) return false;
      return ru.protocol === p.protocol && ru.hostname === p.hostname && ru.pathname === p.pathname;
    });
  }

  /** Authenticate a client at the token endpoint. Public → PKCE only; confidential → secret. */
  authenticateClient(client: OAuthClient, presentedSecret: string | undefined): void {
    if (client.type !== 'confidential') return; // public client, PKCE is the proof
    if (!client.clientSecretHash || !presentedSecret) {
      throw new OAuthFlowError('invalid_client', 'Client authentication failed.', false);
    }
    const a = Buffer.from(this.sha256(presentedSecret), 'hex');
    const b = Buffer.from(client.clientSecretHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new OAuthFlowError('invalid_client', 'Client authentication failed.', false);
    }
  }

  // ── Scopes ───────────────────────────────────────────────

  parseScopes(scope: string | undefined): Permission[] {
    return [...new Set((scope ?? '').split(/\s+/).filter(Boolean))] as Permission[];
  }

  /** Requested ∩ user's permissions ∩ grantable catalog. Empty means nothing grantable. */
  effectiveScopes(userPermissions: Permission[], requested: Permission[]): Permission[] {
    const owned = new Set<string>(userPermissions);
    const grantable = new Set<string>(GRANTABLE_TOKEN_SCOPES);
    return requested.filter((s) => grantable.has(s) && owned.has(s));
  }

  // ── Authorize-request validation ─────────────────────────

  /**
   * Validate the authorize request enough to know we can safely redirect. Throws
   * OAuthFlowError (redirectable=false) for client/redirect problems that must NOT redirect.
   */
  async validateAuthorize(q: {
    client_id?: string;
    redirect_uri?: string;
    response_type?: string;
    code_challenge?: string;
    code_challenge_method?: string;
  }): Promise<{ client: OAuthClient; redirectUri: string }> {
    const client = await this.getEnabledClient(q.client_id ?? '');
    if (!client) throw new OAuthFlowError('invalid_client', 'Unknown or disabled client.', false);

    const redirectUri = q.redirect_uri ?? '';
    if (!redirectUri || !this.redirectUriMatches(client.redirectUris, redirectUri)) {
      throw new OAuthFlowError('invalid_request', 'redirect_uri is not registered for this client.', false);
    }

    // Beyond this point, errors may be reported to the client via redirect.
    if (q.response_type !== 'code') {
      throw new OAuthFlowError('unsupported_response_type', 'Only response_type=code is supported.');
    }
    if (!q.code_challenge) {
      throw new OAuthFlowError('invalid_request', 'PKCE code_challenge is required.');
    }
    if ((q.code_challenge_method ?? 'plain') !== 'S256') {
      throw new OAuthFlowError('invalid_request', 'Only code_challenge_method=S256 is supported.');
    }
    return { client, redirectUri };
  }

  // ── Remembered consent ───────────────────────────────────

  async hasRememberedGrant(userId: string, clientId: string, scopes: Permission[]): Promise<boolean> {
    const grant = await this.prisma.oAuthGrant.findUnique({
      where: { userId_clientId: { userId, clientId } },
    });
    if (!grant || grant.revokedAt) return false;
    const granted = new Set(grant.scopes);
    return scopes.every((s) => granted.has(s));
  }

  async rememberGrant(userId: string, clientId: string, scopes: Permission[]): Promise<void> {
    // Merge with any existing grant's scopes so re-consent never narrows a prior grant.
    const existing = await this.prisma.oAuthGrant.findUnique({
      where: { userId_clientId: { userId, clientId } },
    });
    const merged = [...new Set([...(existing && !existing.revokedAt ? existing.scopes : []), ...scopes])];
    await this.prisma.oAuthGrant.upsert({
      where: { userId_clientId: { userId, clientId } },
      update: { scopes: merged, revokedAt: null },
      create: { userId, clientId, scopes: merged },
    });
  }

  // ── Authorization code ───────────────────────────────────

  async issueCode(input: {
    clientId: string;
    userId: string;
    scopes: Permission[];
    redirectUri: string;
    codeChallenge: string;
    resource?: string;
  }): Promise<string> {
    const code = `oca_${randomBytes(32).toString('base64url')}`;
    await this.prisma.oAuthAuthorizationCode.create({
      data: {
        codeHash: this.sha256(code),
        clientId: input.clientId,
        userId: input.userId,
        scopes: input.scopes,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: 'S256',
        resource: input.resource,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });
    return code;
  }

  /** Build a redirect URL, preserving existing query and appending params. */
  buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    return url.toString();
  }

  // ── Token endpoint ───────────────────────────────────────

  async exchangeAuthCode(input: {
    clientId?: string;
    clientSecret?: string;
    code?: string;
    redirectUri?: string;
    codeVerifier?: string;
  }): Promise<TokenResponse> {
    const client = await this.getEnabledClient(input.clientId ?? '');
    if (!client) throw new OAuthFlowError('invalid_client', 'Unknown or disabled client.', false);
    this.authenticateClient(client, input.clientSecret);

    if (!input.code || !input.codeVerifier || !input.redirectUri) {
      throw new OAuthFlowError('invalid_request', 'code, redirect_uri and code_verifier are required.', false);
    }

    const row = await this.prisma.oAuthAuthorizationCode.findUnique({
      where: { codeHash: this.sha256(input.code) },
    });
    if (!row || row.clientId !== client.clientId) {
      throw new OAuthFlowError('invalid_grant', 'Invalid authorization code.', false);
    }
    // Single-use: a replay (already consumed) is a hard failure.
    if (row.consumedAt) {
      throw new OAuthFlowError('invalid_grant', 'Authorization code already used.', false);
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new OAuthFlowError('invalid_grant', 'Authorization code expired.', false);
    }
    if (row.redirectUri !== input.redirectUri) {
      throw new OAuthFlowError('invalid_grant', 'redirect_uri mismatch.', false);
    }
    // PKCE: base64url(sha256(verifier)) must equal the stored challenge.
    if (this.base64urlSha256(input.codeVerifier) !== row.codeChallenge) {
      throw new OAuthFlowError('invalid_grant', 'PKCE verification failed.', false);
    }

    await this.prisma.oAuthAuthorizationCode.update({
      where: { id: row.id },
      data: { consumedAt: new Date() },
    });

    return this.issueTokens(row.userId, client.clientId, row.scopes as Permission[], row.resource ?? undefined);
  }

  async refreshTokens(input: {
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
  }): Promise<TokenResponse> {
    const client = await this.getEnabledClient(input.clientId ?? '');
    if (!client) throw new OAuthFlowError('invalid_client', 'Unknown or disabled client.', false);
    this.authenticateClient(client, input.clientSecret);

    if (!input.refreshToken) {
      throw new OAuthFlowError('invalid_request', 'refresh_token is required.', false);
    }
    const row = await this.prisma.oAuthRefreshToken.findUnique({
      where: { tokenHash: this.sha256(input.refreshToken) },
    });
    if (!row || row.clientId !== client.clientId) {
      throw new OAuthFlowError('invalid_grant', 'Invalid refresh token.', false);
    }
    if (row.revokedAt) {
      throw new OAuthFlowError('invalid_grant', 'Refresh token revoked.', false);
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new OAuthFlowError('invalid_grant', 'Refresh token expired.', false);
    }

    // Rotate: revoke the old token, then issue a fresh access + refresh pair.
    const issued = await this.issueTokens(
      row.userId,
      client.clientId,
      row.scopes as Permission[],
      row.resource ?? undefined,
    );
    const successor = await this.prisma.oAuthRefreshToken.findUnique({
      where: { tokenHash: this.sha256(issued.refresh_token) },
    });
    await this.prisma.oAuthRefreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date(), rotatedTo: successor?.id ?? null },
    });
    return issued;
  }

  // ── Revocation (RFC 7009) ────────────────────────────────

  /**
   * Revoke a token on behalf of its client (RFC 7009). Only refresh tokens are revocable —
   * access tokens are stateless JWTs and expire on their own. Per spec this is best-effort
   * and always succeeds (unknown tokens included), provided the client authenticates.
   */
  async revokeToken(input: { clientId?: string; clientSecret?: string; token?: string }): Promise<void> {
    const client = await this.getEnabledClient(input.clientId ?? '');
    if (!client) throw new OAuthFlowError('invalid_client', 'Unknown or disabled client.', false);
    this.authenticateClient(client, input.clientSecret);
    if (!input.token) return;

    const row = await this.prisma.oAuthRefreshToken.findUnique({
      where: { tokenHash: this.sha256(input.token) },
    });
    // Only revoke a token that actually belongs to the authenticating client.
    if (row && row.clientId === client.clientId && !row.revokedAt) {
      await this.prisma.oAuthRefreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    }
  }

  // ── Self-service grant management ────────────────────────

  /** A user's remembered authorizations, with the count of their active refresh tokens each. */
  async listUserGrants(userId: string): Promise<OAuthGrantSummary[]> {
    const grants = await this.prisma.oAuthGrant.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (grants.length === 0) return [];

    const clients = await this.prisma.oAuthClient.findMany({
      where: { clientId: { in: grants.map((g) => g.clientId) } },
    });
    const nameById = new Map(clients.map((c) => [c.clientId, c.name]));

    return Promise.all(
      grants.map(async (g) => ({
        clientId: g.clientId,
        clientName: nameById.get(g.clientId) ?? g.clientId,
        scopes: g.scopes as OAuthGrantSummary['scopes'],
        createdAt: g.createdAt.toISOString(),
        activeTokenCount: await this.prisma.oAuthRefreshToken.count({
          where: { userId, clientId: g.clientId, revokedAt: null, expiresAt: { gt: new Date() } },
        }),
      })),
    );
  }

  /** Revoke a user's authorization for a client: the grant and all its live refresh tokens. */
  async revokeUserGrant(userId: string, clientId: string): Promise<void> {
    const now = new Date();
    await this.prisma.oAuthGrant.updateMany({
      where: { userId, clientId, revokedAt: null },
      data: { revokedAt: now },
    });
    await this.prisma.oAuthRefreshToken.updateMany({
      where: { userId, clientId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /** Mint an access-token JWT + a stored refresh token for the given grant. */
  private async issueTokens(
    userId: string,
    clientId: string,
    scopes: Permission[],
    resource?: string,
  ): Promise<TokenResponse> {
    const { token: accessToken, expiresInSec } = await this.tokens.signAccessToken({
      userId,
      clientId,
      scopes,
      resource,
    });
    const refreshToken = `ocr_${randomBytes(32).toString('base64url')}`;
    await this.prisma.oAuthRefreshToken.create({
      data: {
        tokenHash: this.sha256(refreshToken),
        clientId,
        userId,
        scopes,
        resource,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresInSec,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }
}
