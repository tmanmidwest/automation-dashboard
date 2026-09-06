import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { SecretsService } from './secrets.service';
import { CurrentUser, RequirePermissions, SessionOnly } from '../auth/decorators';
import type { SecretSummary, SecretUpsertInput, SessionUser } from '@cerebro/shared';

/**
 * The secrets vault management API. Metadata in, metadata out — a value can be
 * written but is NEVER read back to a client (there is no reveal endpoint). The
 * whole controller is session-only: secrets:* is not a grantable token scope, so
 * a bearer credential can never reach it. See docs/secrets-vault.md.
 */
@Controller('api/secrets')
@SessionOnly()
export class SecretsController {
  constructor(private readonly secrets: SecretsService) {}

  @Get()
  @RequirePermissions('secrets:read')
  list(): Promise<SecretSummary[]> {
    return this.secrets.list();
  }

  /** Set/rotate a secret's value and/or edit its metadata. */
  @Put(':key')
  @RequirePermissions('secrets:write')
  async upsert(
    @Param('key') key: string,
    @Body() body: SecretUpsertInput,
    @CurrentUser() user: SessionUser,
  ): Promise<{ ok: true }> {
    const ctx = { actorId: user.id, actorEmail: user.email };
    const { value, ...meta } = body ?? {};
    if (typeof value === 'string' && value.length > 0) {
      await this.secrets.set(key, value, meta, ctx);
    } else {
      await this.secrets.updateMeta(key, meta, ctx);
    }
    return { ok: true };
  }

  @Delete(':key')
  @RequirePermissions('secrets:write')
  async remove(@Param('key') key: string, @CurrentUser() user: SessionUser): Promise<{ ok: true }> {
    await this.secrets.remove(key, { actorId: user.id, actorEmail: user.email });
    return { ok: true };
  }
}
