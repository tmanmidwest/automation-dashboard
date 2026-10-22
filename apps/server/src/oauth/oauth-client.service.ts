import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import type { OAuthClient } from '@prisma/client';
import { MACHINE_CLIENT_SCOPES, type OAuthClientCreated, type OAuthClientSummary, type Permission } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { cleanIpAllowlist } from '../common/ip-allowlist';

export interface CreateClientInput {
  name: string;
  redirectUris?: string[];
  type?: 'public' | 'confidential' | 'machine';
  allowedScopes?: string[];
  ipAllowlist?: string[];
}

export interface UpdateClientInput {
  name?: string;
  redirectUris?: string[];
  disabled?: boolean;
  allowedScopes?: string[];
  ipAllowlist?: string[];
}

/**
 * Admin-managed registry of OAuth clients (no dynamic registration). Public clients
 * authenticate with PKCE and hold no secret; confidential clients get a secret shown
 * once at creation and stored only as a sha256 hash. Machine clients use client_credentials
 * only (no redirect URIs, no user), hold a secret, and may only be given MACHINE_CLIENT_SCOPES.
 */
@Injectable()
export class OAuthClientService {
  constructor(private readonly prisma: PrismaService) {}

  private hash(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  private toSummary(c: OAuthClient): OAuthClientSummary {
    return {
      id: c.id,
      clientId: c.clientId,
      name: c.name,
      type: c.type === 'confidential' || c.type === 'machine' ? c.type : 'public',
      redirectUris: c.redirectUris,
      disabled: c.disabled,
      clientSecretSet: !!c.clientSecretHash,
      allowedScopes: c.allowedScopes as Permission[],
      ipAllowlist: c.ipAllowlist,
      lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
      secretRotatedAt: c.secretRotatedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    };
  }

  async list(): Promise<OAuthClientSummary[]> {
    const rows = await this.prisma.oAuthClient.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((c) => this.toSummary(c));
  }

  async create(input: CreateClientInput): Promise<OAuthClientCreated> {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('A client name is required.');

    const type = input.type === 'confidential' || input.type === 'machine' ? input.type : 'public';
    const machine = type === 'machine';
    const redirectUris = machine ? [] : this.validateRedirectUris(input.redirectUris ?? []);
    const allowedScopes = machine ? this.validateScopes(input.allowedScopes ?? MACHINE_CLIENT_SCOPES) : [];
    const ipAllowlist = machine ? this.validateIps(input.ipAllowlist ?? []) : [];

    const clientId = `oc_${randomBytes(12).toString('hex')}`;
    let clientSecret: string | undefined;
    let clientSecretHash: string | null = null;
    if (type !== 'public') {
      clientSecret = `ocs_${randomBytes(24).toString('base64url')}`;
      clientSecretHash = this.hash(clientSecret);
    }

    const row = await this.prisma.oAuthClient.create({
      data: { clientId, name, type, clientSecretHash, redirectUris, allowedScopes, ipAllowlist },
    });
    return { client: this.toSummary(row), clientSecret };
  }

  async update(id: string, patch: UpdateClientInput): Promise<OAuthClientSummary> {
    const current = await this.getOrThrow(id);
    const machine = current.type === 'machine';
    const data: { name?: string; redirectUris?: string[]; disabled?: boolean; allowedScopes?: string[]; ipAllowlist?: string[] } = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new BadRequestException('A client name is required.');
      data.name = name;
    }
    if (patch.redirectUris !== undefined && !machine) data.redirectUris = this.validateRedirectUris(patch.redirectUris);
    if (patch.disabled !== undefined) data.disabled = patch.disabled;
    if (patch.allowedScopes !== undefined && machine) data.allowedScopes = this.validateScopes(patch.allowedScopes);
    if (patch.ipAllowlist !== undefined && machine) data.ipAllowlist = this.validateIps(patch.ipAllowlist);

    const row = await this.prisma.oAuthClient.update({ where: { id }, data });
    return this.toSummary(row);
  }

  /** New secret for a confidential or machine client; the old one stops working at once. */
  async rotateSecret(id: string): Promise<OAuthClientCreated> {
    const current = await this.getOrThrow(id);
    if (current.type === 'public') throw new BadRequestException('Public clients have no secret.');
    const clientSecret = `ocs_${randomBytes(24).toString('base64url')}`;
    const row = await this.prisma.oAuthClient.update({
      where: { id },
      data: { clientSecretHash: this.hash(clientSecret), secretRotatedAt: new Date() },
    });
    return { client: this.toSummary(row), clientSecret };
  }

  async remove(id: string): Promise<void> {
    await this.getOrThrow(id);
    await this.prisma.oAuthClient.delete({ where: { id } });
  }

  private async getOrThrow(id: string): Promise<OAuthClient> {
    const row = await this.prisma.oAuthClient.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('OAuth client not found.');
    return row;
  }

  private validateScopes(scopes: string[]): string[] {
    const cleaned = [...new Set((scopes ?? []).map((s) => String(s).trim()).filter(Boolean))];
    const bad = cleaned.filter((s) => !MACHINE_CLIENT_SCOPES.includes(s as Permission));
    if (bad.length) throw new BadRequestException(`Machine clients may only hold: ${MACHINE_CLIENT_SCOPES.join(', ')}.`);
    if (!cleaned.length) throw new BadRequestException('A machine client needs at least one scope.');
    return cleaned;
  }

  private validateIps(entries: string[]): string[] {
    try {
      return cleanIpAllowlist(entries);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'Invalid IP allowlist.');
    }
  }

  /** Redirect URIs must be absolute http(s) URLs; require https unless loopback. */
  private validateRedirectUris(uris: string[]): string[] {
    if (!Array.isArray(uris) || uris.length === 0) {
      throw new BadRequestException('At least one redirect URI is required.');
    }
    const cleaned = [...new Set(uris.map((u) => u.trim()).filter(Boolean))];
    for (const uri of cleaned) {
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        throw new BadRequestException(`Invalid redirect URI: ${uri}`);
      }
      const isLoopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
        throw new BadRequestException(`Redirect URI must be https (or http on loopback): ${uri}`);
      }
    }
    return cleaned;
  }
}
