import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import type { OAuthClient } from '@prisma/client';
import type { OAuthClientCreated, OAuthClientSummary } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateClientInput {
  name: string;
  redirectUris: string[];
  type?: 'public' | 'confidential';
}

/**
 * Admin-managed registry of OAuth clients (no dynamic registration). Public clients
 * authenticate with PKCE and hold no secret; confidential clients get a secret shown
 * once at creation and stored only as a sha256 hash.
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
      type: c.type === 'confidential' ? 'confidential' : 'public',
      redirectUris: c.redirectUris,
      disabled: c.disabled,
      clientSecretSet: !!c.clientSecretHash,
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

    const type = input.type === 'confidential' ? 'confidential' : 'public';
    const redirectUris = this.validateRedirectUris(input.redirectUris);

    const clientId = `oc_${randomBytes(12).toString('hex')}`;
    let clientSecret: string | undefined;
    let clientSecretHash: string | null = null;
    if (type === 'confidential') {
      clientSecret = `ocs_${randomBytes(24).toString('base64url')}`;
      clientSecretHash = this.hash(clientSecret);
    }

    const row = await this.prisma.oAuthClient.create({
      data: { clientId, name, type, clientSecretHash, redirectUris },
    });
    return { client: this.toSummary(row), clientSecret };
  }

  async update(
    id: string,
    patch: { name?: string; redirectUris?: string[]; disabled?: boolean },
  ): Promise<OAuthClientSummary> {
    await this.getOrThrow(id);
    const data: { name?: string; redirectUris?: string[]; disabled?: boolean } = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new BadRequestException('A client name is required.');
      data.name = name;
    }
    if (patch.redirectUris !== undefined) data.redirectUris = this.validateRedirectUris(patch.redirectUris);
    if (patch.disabled !== undefined) data.disabled = patch.disabled;

    const row = await this.prisma.oAuthClient.update({ where: { id }, data });
    return this.toSummary(row);
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
