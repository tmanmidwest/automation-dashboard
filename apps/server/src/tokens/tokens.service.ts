import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiToken } from '@prisma/client';
import type { ApiTokenCreated, ApiTokenSummary, Permission, SessionUser } from '@cerebro/shared';
import { GRANTABLE_TOKEN_SCOPES } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TokenAuthService } from '../auth/token-auth.service';
import { AuditService } from '../logging/audit.service';

/**
 * Self-service management of a user's own API tokens. Scopes are limited to the grantable
 * catalog (read scopes + connectors:action / monitors:write) and clamped to the caller's own
 * permissions — a token can never grant more than its owner holds.
 */
@Injectable()
export class TokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenAuth: TokenAuthService,
    private readonly audit: AuditService,
  ) {}

  private toSummary(t: ApiToken): ApiTokenSummary {
    return {
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      scopes: t.scopes as Permission[],
      lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      expiresAt: t.expiresAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    };
  }

  async list(userId: string): Promise<ApiTokenSummary[]> {
    const rows = await this.prisma.apiToken.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((t) => this.toSummary(t));
  }

  async create(
    user: SessionUser,
    input: { name: string; scopes: string[]; expiresAt?: string },
  ): Promise<ApiTokenCreated> {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('A token name is required.');

    const scopes = this.validateScopes(user, input.scopes);

    let expiresAt: Date | undefined;
    if (input.expiresAt) {
      const d = new Date(input.expiresAt);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid expiry date.');
      if (d.getTime() <= Date.now()) throw new BadRequestException('Expiry must be in the future.');
      expiresAt = d;
    }

    const { plaintext, prefix, hash } = this.tokenAuth.generate();
    const row = await this.prisma.apiToken.create({
      data: { userId: user.id, name, prefix, hash, scopes, expiresAt },
    });

    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'tokens.created',
      target: name,
      meta: { prefix, scopes },
    });

    return { token: this.toSummary(row), secret: plaintext };
  }

  async revoke(user: SessionUser, id: string): Promise<void> {
    const token = await this.prisma.apiToken.findFirst({
      where: { id, userId: user.id, revokedAt: null },
    });
    if (!token) throw new NotFoundException('Token not found.');

    await this.prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'tokens.revoked',
      target: token.name,
      meta: { prefix: token.prefix },
    });
  }

  /** Scopes must be non-empty, grantable to a token, and held by the owner. */
  private validateScopes(user: SessionUser, requested: string[]): string[] {
    if (!Array.isArray(requested) || requested.length === 0) {
      throw new BadRequestException('At least one scope is required.');
    }
    const scopes = [...new Set(requested)];
    const grantable = new Set<string>(GRANTABLE_TOKEN_SCOPES);
    const owned = new Set<string>(user.permissions);
    for (const scope of scopes) {
      if (!grantable.has(scope)) {
        throw new BadRequestException(`Scope "${scope}" cannot be granted to a token.`);
      }
      if (!owned.has(scope)) {
        throw new BadRequestException(`You do not hold the "${scope}" permission.`);
      }
    }
    return scopes;
  }
}
