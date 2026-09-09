import { BadRequestException, Body, Controller, Get, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import type { Response } from 'express';
import type { SessionUser } from '@cerebro/shared';
import { SystemBackupService } from './system-backup.service';
import { AuditService } from '../logging/audit.service';
import { CurrentUser, RequirePermissions, SessionOnly } from '../auth/decorators';

/** The subset of multer's file object we use (avoids a @types/multer dependency). */
interface UploadedTempFile { path: string; size: number; originalname: string }

/**
 * Full system backup & restore. Session-only + settings:write (admin) — a backup contains every
 * secret, so it must never be reachable with an API token. See docs/system-backup.md.
 */
@Controller('api/system')
@SessionOnly()
export class SystemBackupController {
  constructor(
    private readonly backup: SystemBackupService,
    private readonly audit: AuditService,
  ) {}

  @Get('backup/info')
  @RequirePermissions('settings:write')
  info() {
    return this.backup.info();
  }

  @Post('backup')
  @RequirePermissions('settings:write')
  async create(@Body('passphrase') passphrase: string, @CurrentUser() user: SessionUser, @Res() res: Response) {
    const { filename, data } = await this.backup.createBackup(passphrase);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'system.backup', meta: { bytes: data.length, filename } });
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(data.length),
    });
    res.send(data);
  }

  @Post('restore')
  @RequirePermissions('settings:write')
  @UseInterceptors(FileInterceptor('file', { dest: tmpdir(), limits: { fileSize: 2 * 1024 * 1024 * 1024 } }))
  async restore(
    @UploadedFile() file: UploadedTempFile | undefined,
    @Body('passphrase') passphrase: string,
    @CurrentUser() user: SessionUser,
  ) {
    if (!file?.path) throw new BadRequestException('Upload the backup file in the "file" field.');
    try {
      const buf = await fs.readFile(file.path);
      const r = await this.backup.restore(buf, passphrase);
      await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'system.restore', meta: { ok: r.ok } });
      return r;
    } finally {
      await fs.rm(file.path, { force: true }).catch(() => {});
    }
  }
}
