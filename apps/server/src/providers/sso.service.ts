import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { Issuer, generators, Client } from 'openid-client';
import type { IdentityProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { LoggingService } from '../logging/logging.service';
import { IdentityProviderService } from './identity-provider.service';
import { BUILTIN_ROLES } from '@cerebro/shared';

@Injectable()
export class SsoService {
  /** Discovery/client cache keyed by provider id (invalidated when issuer/clientId change). */
  private clientCache = new Map<string, { issuer: string; clientId: string; client: Client }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: IdentityProviderService,
    private readonly audit: AuditService,
    private readonly logging: LoggingService,
  ) {}

  invalidate(providerId: string) {
    this.clientCache.delete(providerId);
  }

  private async buildClient(provider: IdentityProvider): Promise<Client> {
    const cached = this.clientCache.get(provider.id);
    if (cached && cached.issuer === provider.issuer && cached.clientId === provider.clientId) {
      return cached.client;
    }
    const secret = (await this.providers.getSecret(provider.id)) ?? undefined;
    const issuer = await Issuer.discover(provider.issuer);
    const client = new issuer.Client({
      client_id: provider.clientId,
      client_secret: secret,
      redirect_uris: [this.providers.redirectUri(provider.slug)],
      response_types: ['code'],
    });
    this.clientCache.set(provider.id, { issuer: provider.issuer, clientId: provider.clientId, client });
    return client;
  }

  /** Verifies discovery + credentials without logging anyone in. */
  async testProvider(providerId: string): Promise<{ ok: boolean; message: string }> {
    const provider = await this.providers.getById(providerId);
    try {
      const issuer = await Issuer.discover(provider.issuer);
      return {
        ok: true,
        message: `Discovered ${issuer.metadata.issuer}. Authorization endpoint is reachable.`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Discovery failed.' };
    }
  }

  async buildAuthUrl(req: Request, slug: string): Promise<string> {
    const provider = await this.providers.getBySlug(slug);
    if (!provider || !provider.enabled) throw new NotFoundException('Unknown or disabled provider.');
    const client = await this.buildClient(provider);

    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    req.session.sso = { providerId: provider.id, state, nonce, codeVerifier };

    return client.authorizationUrl({
      scope: provider.scopes || 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  /** Completes the flow, applies the provider's provisioning policy, returns the user id. */
  async handleCallback(req: Request, slug: string): Promise<string> {
    const provider = await this.providers.getBySlug(slug);
    if (!provider || !provider.enabled) throw new NotFoundException('Unknown or disabled provider.');

    const stored = req.session.sso;
    if (!stored || stored.providerId !== provider.id) {
      throw new BadRequestException('Missing or mismatched SSO state — restart sign-in.');
    }
    delete req.session.sso;

    const client = await this.buildClient(provider);
    const params = client.callbackParams(req);
    const tokenSet = await client.callback(this.providers.redirectUri(provider.slug), params, {
      state: stored.state,
      nonce: stored.nonce,
      code_verifier: stored.codeVerifier,
    });
    const claims = tokenSet.claims();
    const subject = claims.sub;
    const email = (claims.email as string | undefined)?.toLowerCase();
    const emailVerified = claims.email_verified === true;
    const displayName =
      (claims.name as string | undefined) ||
      (claims.preferred_username as string | undefined) ||
      email ||
      subject;

    // 1) Known identity → straight in.
    const identity = await this.prisma.userIdentity.findUnique({
      where: { providerId_subject: { providerId: provider.id, subject } },
      include: { user: true },
    });
    if (identity) {
      if (identity.user.disabled) throw new ForbiddenException('This account is disabled.');
      await this.prisma.user.update({ where: { id: identity.userId }, data: { lastLoginAt: new Date() } });
      return identity.userId;
    }

    // From here we're provisioning or linking — enforce the domain allowlist.
    if (!email) throw new BadRequestException('Provider did not return an email claim.');
    if (provider.allowedDomains.length > 0) {
      const domain = email.split('@')[1];
      if (!provider.allowedDomains.includes(domain)) {
        await this.audit.record({
          actorEmail: email,
          action: 'auth.sso_domain_rejected',
          target: provider.label,
          meta: { domain },
        });
        throw new ForbiddenException(`Email domain "${domain}" is not permitted for ${provider.label}.`);
      }
    }

    // 2) Link to an existing account by email — only if the provider verified it.
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      if (!emailVerified) {
        throw new ForbiddenException(
          'An account with this email exists but the provider did not verify the email address. Ask an admin to link it.',
        );
      }
      if (existing.disabled) throw new ForbiddenException('This account is disabled.');
      await this.prisma.userIdentity.create({
        data: { userId: existing.id, providerId: provider.id, subject, email },
      });
      await this.prisma.user.update({ where: { id: existing.id }, data: { lastLoginAt: new Date() } });
      await this.audit.record({
        actorId: existing.id,
        actorEmail: email,
        action: 'auth.sso_identity_linked',
        target: provider.label,
      });
      return existing.id;
    }

    // 3) No account — provision only if this provider allows it.
    if (!provider.autoCreateUsers) {
      await this.audit.record({
        actorEmail: email,
        action: 'auth.sso_provision_denied',
        target: provider.label,
      });
      throw new ForbiddenException(
        `No Cerebro account exists for ${email}. Contact an administrator to be invited.`,
      );
    }

    const role = await this.ensureRole(provider.defaultRoleSlug);
    const user = await this.prisma.user.create({
      data: {
        email,
        displayName: displayName!,
        authProvider: 'oidc',
        roleId: role.id,
        identities: { create: { providerId: provider.id, subject, email } },
      },
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: email,
      action: 'auth.sso_user_provisioned',
      target: provider.label,
      meta: { roleSlug: role.slug },
    });
    await this.logging.info('auth', `Provisioned ${email} via ${provider.label} as ${role.slug}.`);
    return user.id;
  }

  /** Ensures the given role exists (falls back to seeding a built-in if referenced). */
  private async ensureRole(slug: string) {
    const existing = await this.prisma.role.findUnique({ where: { slug } });
    if (existing) return existing;
    const builtin = Object.values(BUILTIN_ROLES).find((r) => r.slug === slug) ?? BUILTIN_ROLES.viewer;
    return this.prisma.role.upsert({
      where: { slug: builtin.slug },
      update: {},
      create: {
        slug: builtin.slug,
        name: builtin.name,
        description: builtin.description,
        permissions: [...builtin.permissions],
        builtin: true,
      },
    });
  }
}
