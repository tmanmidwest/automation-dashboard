import { BadRequestException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { Issuer, generators, Client } from 'openid-client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../logging/audit.service';
import { BUILTIN_ROLES } from '@cerebro/shared';

interface OidcConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  /** Optional display label for the login button. */
  buttonLabel?: string;
}

/**
 * Generic OIDC / OAuth2 provider — configured entirely from the UI (Settings →
 * Authentication). Works with Entra ID, Google, Authentik, Keycloak, etc.
 * Nothing about a specific provider is hardcoded.
 */
@Injectable()
export class OidcService {
  private cachedClient?: { issuer: string; clientId: string; client: Client };

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async getConfig(): Promise<OidcConfig> {
    return {
      enabled: (await this.settings.get<boolean>('oidc.enabled')) ?? false,
      issuer: (await this.settings.get<string>('oidc.issuer')) ?? '',
      clientId: (await this.settings.get<string>('oidc.clientId')) ?? '',
      buttonLabel: (await this.settings.get<string>('oidc.buttonLabel')) ?? 'Sign in with SSO',
    };
  }

  /** Public-facing status for the login screen (no secrets). */
  async publicStatus(): Promise<{ enabled: boolean; buttonLabel: string }> {
    const cfg = await this.getConfig();
    return { enabled: cfg.enabled && !!cfg.issuer && !!cfg.clientId, buttonLabel: cfg.buttonLabel! };
  }

  private redirectUri(): string {
    const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    return `${base}/api/auth/oidc/callback`;
  }

  private async getClient(): Promise<Client> {
    const cfg = await this.getConfig();
    if (!cfg.enabled || !cfg.issuer || !cfg.clientId) {
      throw new BadRequestException('OIDC is not configured.');
    }
    const clientSecret = (await this.settings.getSecret('oidc.clientSecret')) ?? undefined;

    if (
      this.cachedClient &&
      this.cachedClient.issuer === cfg.issuer &&
      this.cachedClient.clientId === cfg.clientId
    ) {
      return this.cachedClient.client;
    }

    const issuer = await Issuer.discover(cfg.issuer);
    const client = new issuer.Client({
      client_id: cfg.clientId,
      client_secret: clientSecret,
      redirect_uris: [this.redirectUri()],
      response_types: ['code'],
    });
    this.cachedClient = { issuer: cfg.issuer, clientId: cfg.clientId, client };
    return client;
  }

  /** Clears the discovery cache after config changes. */
  invalidate() {
    this.cachedClient = undefined;
  }

  async buildAuthUrl(req: Request): Promise<string> {
    const client = await this.getClient();
    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);

    req.session.oidc = { state, nonce, codeVerifier };

    return client.authorizationUrl({
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  /** Completes the auth-code flow, provisions/updates the user, returns the user id. */
  async handleCallback(req: Request): Promise<string> {
    const client = await this.getClient();
    const stored = req.session.oidc;
    if (!stored) throw new BadRequestException('Missing OIDC state — restart sign-in.');
    delete req.session.oidc;

    const params = client.callbackParams(req);
    const tokenSet = await client.callback(this.redirectUri(), params, {
      state: stored.state,
      nonce: stored.nonce,
      code_verifier: stored.codeVerifier,
    });
    const claims = tokenSet.claims();
    const subject = claims.sub;
    const email = (claims.email as string | undefined)?.toLowerCase();
    const displayName =
      (claims.name as string | undefined) || (claims.preferred_username as string | undefined) || email || subject;

    if (!email) {
      throw new BadRequestException('OIDC provider did not return an email claim.');
    }

    // Match by subject first, then by email (links an existing local account).
    let user =
      (await this.prisma.user.findUnique({ where: { oidcSubject: subject } })) ??
      (await this.prisma.user.findUnique({ where: { email } }));

    if (!user) {
      const viewer = await this.ensureViewerRole();
      user = await this.prisma.user.create({
        data: {
          email,
          displayName: displayName!,
          authProvider: 'oidc',
          oidcSubject: subject,
          roleId: viewer.id,
        },
      });
      await this.audit.record({
        actorId: user.id,
        actorEmail: email,
        action: 'auth.oidc_user_provisioned',
        target: email,
      });
    } else {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { oidcSubject: subject, lastLoginAt: new Date() },
      });
    }

    if (user.disabled) throw new BadRequestException('This account is disabled.');
    return user.id;
  }

  private async ensureViewerRole() {
    const slug = BUILTIN_ROLES.viewer.slug;
    return this.prisma.role.upsert({
      where: { slug },
      update: {},
      create: {
        slug,
        name: BUILTIN_ROLES.viewer.name,
        description: BUILTIN_ROLES.viewer.description,
        permissions: BUILTIN_ROLES.viewer.permissions,
        builtin: true,
      },
    });
  }
}
