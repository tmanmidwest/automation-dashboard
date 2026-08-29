import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import type { IdentityProvider } from '@prisma/client';

export interface ProviderInput {
  label: string;
  issuer: string;
  clientId: string;
  buttonLabel?: string;
  icon?: string;
  scopes?: string;
  enabled?: boolean;
  autoCreateUsers?: boolean;
  defaultRoleSlug?: string;
  allowedDomains?: string[];
  /** Set/replace the client secret; blank leaves it unchanged. */
  clientSecret?: string;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'provider'
  );
}

@Injectable()
export class IdentityProviderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  private secretKey(id: string) {
    return `idp:${id}:clientSecret`;
  }

  redirectUri(slug: string): string {
    const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    return `${base}/api/auth/sso/${slug}/callback`;
  }

  async list(): Promise<IdentityProvider[]> {
    return this.prisma.identityProvider.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  }

  /** Enabled providers only, for the login screen. */
  async listEnabled(): Promise<IdentityProvider[]> {
    return this.prisma.identityProvider.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async getBySlug(slug: string): Promise<IdentityProvider | null> {
    return this.prisma.identityProvider.findUnique({ where: { slug } });
  }

  async getById(id: string): Promise<IdentityProvider> {
    const p = await this.prisma.identityProvider.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Provider not found.');
    return p;
  }

  async hasSecret(id: string): Promise<boolean> {
    return this.settings.hasSecret(this.secretKey(id));
  }

  async getSecret(id: string): Promise<string | null> {
    return this.settings.getSecret(this.secretKey(id));
  }

  private async uniqueSlug(base: string): Promise<string> {
    const root = slugify(base);
    let candidate = root;
    let n = 1;
    // eslint-disable-next-line no-await-in-loop
    while (await this.prisma.identityProvider.findUnique({ where: { slug: candidate } })) {
      candidate = `${root}-${++n}`;
    }
    return candidate;
  }

  async create(input: ProviderInput): Promise<IdentityProvider> {
    if (!input.label?.trim()) throw new BadRequestException('Label is required.');
    if (!input.issuer?.trim()) throw new BadRequestException('Issuer URL is required.');
    if (!input.clientId?.trim()) throw new BadRequestException('Client ID is required.');

    const max = await this.prisma.identityProvider.aggregate({ _max: { sortOrder: true } });
    const provider = await this.prisma.identityProvider.create({
      data: {
        slug: await this.uniqueSlug(input.label),
        label: input.label.trim(),
        type: 'oidc',
        issuer: input.issuer.trim(),
        clientId: input.clientId.trim(),
        buttonLabel: input.buttonLabel?.trim() || `Sign in with ${input.label.trim()}`,
        icon: input.icon || 'generic',
        scopes: input.scopes?.trim() || 'openid email profile',
        enabled: input.enabled ?? false,
        autoCreateUsers: input.autoCreateUsers ?? false,
        defaultRoleSlug: input.defaultRoleSlug || 'viewer',
        allowedDomains: normalizeDomains(input.allowedDomains),
        sortOrder: (max._max.sortOrder ?? 0) + 1,
      },
    });
    if (input.clientSecret) {
      await this.settings.setSecret(this.secretKey(provider.id), input.clientSecret);
    }
    return provider;
  }

  async update(id: string, input: ProviderInput): Promise<IdentityProvider> {
    await this.getById(id);
    const provider = await this.prisma.identityProvider.update({
      where: { id },
      data: {
        label: input.label.trim(),
        issuer: input.issuer.trim(),
        clientId: input.clientId.trim(),
        buttonLabel: input.buttonLabel?.trim() || undefined,
        icon: input.icon || undefined,
        scopes: input.scopes?.trim() || undefined,
        enabled: input.enabled,
        autoCreateUsers: input.autoCreateUsers,
        defaultRoleSlug: input.defaultRoleSlug || undefined,
        allowedDomains: normalizeDomains(input.allowedDomains),
      },
    });
    if (input.clientSecret) {
      await this.settings.setSecret(this.secretKey(id), input.clientSecret);
    }
    return provider;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.getById(id);
    await this.prisma.identityProvider.update({ where: { id }, data: { enabled } });
  }

  async remove(id: string): Promise<void> {
    await this.getById(id);
    await this.settings.deleteSecret(this.secretKey(id));
    await this.prisma.identityProvider.delete({ where: { id } });
  }
}

function normalizeDomains(domains?: string[]): string[] {
  if (!domains) return [];
  return domains
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => d.length > 0);
}
