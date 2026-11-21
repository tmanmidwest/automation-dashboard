import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { SecretsService } from './secrets.service';
import { CurrentUser, RequirePermissions, SessionOnly } from '../auth/decorators';
import type { SecretCredentialFieldsResult, SecretSummary, SecretUpsertInput, SessionUser } from '@cerebro/shared';

/**
 * The secrets vault management API. Metadata in, metadata out — a value can be
 * written here but is only ever read back through the step-up reveal endpoint in
 * {@link SecretsRevealModule}. The whole controller is session-only: secrets:* is
 * not a grantable token scope, so a bearer credential can never reach it. See
 * docs/secrets-vault.md.
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

  /**
   * The non-secret fields of a typed credential (username, RDP domain, git host) so the
   * Rotate dialog can show and edit them. The password/key/token is never returned.
   */
  @Get(':key/fields')
  @RequirePermissions('secrets:write')
  fields(@Param('key') key: string): Promise<SecretCredentialFieldsResult> {
    return this.secrets.credentialFields(key);
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
    const { value, fields, ...meta } = body ?? {};
    if ((typeof value === 'string' && value.length > 0) || fields) {
      await this.secrets.rotate(key, value, fields, meta, ctx);
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
