import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, Public, RequirePermissions, SessionOnly } from '../auth/decorators';
import type { SessionUser } from '@cerebro/shared';
import { FabricService } from './fabric.service';
import { FabricSftpService } from './fabric-sftp.service';
import { FabricEnrollmentService } from './fabric-enrollment.service';
import { installPs1, installSh, uninstallPs1, uninstallSh } from './agent-installers';

class CreateAgentDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  os?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

class EnrollDto {
  @IsString()
  token!: string;
}

class SshConnectDto {
  @IsOptional()
  @IsBoolean()
  useSaved?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  secretRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  privateKey?: string;

  @IsOptional()
  @IsString()
  passphrase?: string;

  @IsOptional()
  @IsBoolean()
  save?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  saveAs?: string;
}

class RdpConnectDto {
  @IsOptional()
  @IsBoolean()
  useSaved?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  secretRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  domain?: string;

  @IsOptional()
  @IsBoolean()
  save?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  saveAs?: string;

  @IsOptional()
  @IsInt()
  @Min(320)
  @Max(7680)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(240)
  @Max(4320)
  height?: number;

  @IsOptional()
  @IsInt()
  colorDepth?: number;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  security?: string;

  @IsOptional()
  @IsBoolean()
  consoleSession?: boolean;

  @IsOptional()
  @IsBoolean()
  enableEffects?: boolean;

  @IsOptional()
  @IsBoolean()
  disableAudio?: boolean;
}

class VncConnectDto {
  @IsOptional()
  @IsBoolean()
  useSaved?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  secretRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsBoolean()
  save?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  saveAs?: string;
}

class SftpPathDto {
  @IsString()
  @MaxLength(4096)
  path!: string;
}

class SftpRenameDto {
  @IsString()
  @MaxLength(4096)
  from!: string;

  @IsString()
  @MaxLength(4096)
  to!: string;
}

class SftpRemoveDto {
  @IsString()
  @MaxLength(4096)
  path!: string;

  @IsOptional()
  @IsBoolean()
  dir?: boolean;
}

/** Where prebuilt agent binaries are served from (populated by CI / a release step). */
const AGENT_DIST_DIR = process.env.FABRIC_AGENT_DIST_DIR || '/app/agent-dist';
const AGENT_ARTIFACTS: Record<string, { file: string; contentType: string; download: string }> = {
  'linux/amd64': { file: 'cerebro-agent-linux-amd64', contentType: 'application/octet-stream', download: 'cerebro-agent' },
  'linux/arm64': { file: 'cerebro-agent-linux-arm64', contentType: 'application/octet-stream', download: 'cerebro-agent' },
  'darwin/amd64': { file: 'cerebro-agent-darwin-amd64', contentType: 'application/octet-stream', download: 'cerebro-agent' },
  'darwin/arm64': { file: 'cerebro-agent-darwin-arm64', contentType: 'application/octet-stream', download: 'cerebro-agent' },
  'windows/amd64': { file: 'cerebro-agent-windows-amd64.exe', contentType: 'application/octet-stream', download: 'cerebro-agent.exe' },
};

/** Where prebuilt `cerebro` CLI binaries are served from. */
const CLI_DIST_DIR = process.env.FABRIC_CLI_DIST_DIR || '/app/cli-dist';
const CLI_ARTIFACTS: Record<string, { file: string; download: string }> = {
  'linux/amd64': { file: 'cerebro-linux-amd64', download: 'cerebro' },
  'linux/arm64': { file: 'cerebro-linux-arm64', download: 'cerebro' },
  'darwin/amd64': { file: 'cerebro-darwin-amd64', download: 'cerebro' },
  'darwin/arm64': { file: 'cerebro-darwin-arm64', download: 'cerebro' },
  'windows/amd64': { file: 'cerebro-windows-amd64.exe', download: 'cerebro.exe' },
};

@Controller('api/fabric')
export class FabricController {
  constructor(
    private readonly fabric: FabricService,
    private readonly sftp: FabricSftpService,
    private readonly enrollment: FabricEnrollmentService,
  ) {}

  // --- Management (session-gated) --------------------------------------------

  @Get('agents')
  @RequirePermissions('fabric:read')
  listAgents() {
    return this.fabric.listAgents();
  }

  /** Operator-tunable cadences for the web UI (e.g. the agent-list poll interval). */
  @Get('config')
  @RequirePermissions('fabric:read')
  config() {
    return this.fabric.clientConfig();
  }

  @Post('agents')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  createAgent(@Body() body: CreateAgentDto, @CurrentUser() user: SessionUser) {
    return this.fabric.createAgent(body, user);
  }

  @Post('agents/:id/revoke')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  revokeAgent(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.fabric.revokeAgent(id, user);
  }

  @Delete('agents/:id')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  async deleteAgent(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    await this.fabric.deleteAgent(id, user);
    return { ok: true };
  }

  @Get('sessions')
  @RequirePermissions('fabric:read')
  listSessions(@Query('agentId') agentId?: string) {
    return this.fabric.listSessions(agentId);
  }

  /** Vault credentials selectable in the connect dialog (ssh/rdp). */
  @Get('credentials')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  listCredentials(@Query('kind') kind?: string) {
    return this.fabric.listCredentials(kind === 'rdp' ? 'rdp' : kind === 'vnc' ? 'vnc' : 'ssh');
  }

  /** Stream a session's recording for playback (Guacamole recording format). */
  @Get('recordings/:sessionId')
  @RequirePermissions('fabric:read')
  async getRecording(@Param('sessionId') sessionId: string, @Res() res: Response) {
    const path = await this.fabric.recordingPath(sessionId);
    if (!path) throw new NotFoundException('No recording for this session.');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.sendFile(path);
  }

  /** Prove the tunnel to a target end-to-end (Phase 2). */
  @Post('agents/:id/targets/:targetId/probe')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  probeTarget(
    @Param('id') id: string,
    @Param('targetId') targetId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.fabric.probeTarget(id, targetId, user);
  }

  /** Mint a one-time ticket for an interactive SSH session (Phase 3). */
  @Post('agents/:id/targets/:targetId/session')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  openSession(
    @Param('id') id: string,
    @Param('targetId') targetId: string,
    @Body() body: SshConnectDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.fabric.openSshSession(id, targetId, body, user);
  }

  /** Mint an encrypted token for an in-browser RDP session (Phase 4). */
  @Post('agents/:id/targets/:targetId/rdp-session')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  openRdpSession(
    @Param('id') id: string,
    @Param('targetId') targetId: string,
    @Body() body: RdpConnectDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.fabric.openRdpSession(id, targetId, body, user);
  }

  /** Mint a one-time ticket for an in-browser VNC session (macOS Screen Sharing). */
  @Post('agents/:id/targets/:targetId/vnc-session')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  openVncSession(
    @Param('id') id: string,
    @Param('targetId') targetId: string,
    @Body() body: VncConnectDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.fabric.openVncSession(id, targetId, body, user);
  }

  // --- SFTP file browser (over the SSH target) -------------------------------

  /** Open an SFTP session to a host's SSH target; returns its id + home listing. */
  @Post('agents/:id/targets/:targetId/sftp/open')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  openSftp(
    @Param('id') id: string,
    @Param('targetId') targetId: string,
    @Body() body: SshConnectDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.sftp.open(id, targetId, body, user);
  }

  @Post('sftp/:sessionId/ls')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  sftpList(@Param('sessionId') sessionId: string, @Body() body: SftpPathDto, @CurrentUser() user: SessionUser) {
    return this.sftp.list(sessionId, user, body.path);
  }

  @Post('sftp/:sessionId/mkdir')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  async sftpMkdir(@Param('sessionId') sessionId: string, @Body() body: SftpPathDto, @CurrentUser() user: SessionUser) {
    await this.sftp.mkdir(sessionId, user, body.path);
    return { ok: true };
  }

  @Post('sftp/:sessionId/rename')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  async sftpRename(@Param('sessionId') sessionId: string, @Body() body: SftpRenameDto, @CurrentUser() user: SessionUser) {
    await this.sftp.rename(sessionId, user, body.from, body.to);
    return { ok: true };
  }

  @Post('sftp/:sessionId/rm')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  async sftpRemove(@Param('sessionId') sessionId: string, @Body() body: SftpRemoveDto, @CurrentUser() user: SessionUser) {
    await this.sftp.remove(sessionId, user, body.path, !!body.dir);
    return { ok: true };
  }

  /** Stream a remote file down to the browser. */
  @Get('sftp/:sessionId/download')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  async sftpDownload(
    @Param('sessionId') sessionId: string,
    @Query('path') path: string,
    @CurrentUser() user: SessionUser,
    @Res() res: Response,
  ) {
    if (!path) throw new BadRequestException('A path is required.');
    const { stream, name, size } = await this.sftp.download(sessionId, user, path);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    stream.on('error', () => {
      if (!res.headersSent) res.status(502);
      res.end();
    });
    stream.pipe(res);
  }

  /** Stream an uploaded file (raw request body) into a remote directory. */
  @Post('sftp/:sessionId/upload')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  async sftpUpload(
    @Param('sessionId') sessionId: string,
    @Query('dir') dir: string,
    @Query('name') name: string,
    @CurrentUser() user: SessionUser,
    @Req() req: Request,
  ) {
    if (!dir || !name) throw new BadRequestException('A target directory and filename are required.');
    await this.sftp.upload(sessionId, user, dir, name, req);
    return { ok: true };
  }

  @Post('sftp/:sessionId/close')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  sftpClose(@Param('sessionId') sessionId: string, @CurrentUser() user: SessionUser) {
    this.sftp.close(sessionId, user);
    return { ok: true };
  }

  /** Forget a target's vault-stored credential (Phase 3.5). */
  @Delete('agents/:id/targets/:targetId/credential')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  async clearCredential(
    @Param('id') id: string,
    @Param('targetId') targetId: string,
    @CurrentUser() user: SessionUser,
  ) {
    await this.fabric.clearTargetCredential(id, targetId, user);
    return { ok: true };
  }

  /** Reset a target's pinned SSH host key — TOFU re-learns on next connect (Phase 4b). */
  @Delete('agents/:id/targets/:targetId/hostkey')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  async clearHostKey(
    @Param('id') id: string,
    @Param('targetId') targetId: string,
    @CurrentUser() user: SessionUser,
  ) {
    await this.fabric.clearHostKey(id, targetId, user);
    return { ok: true };
  }

  // --- Installer surface (public; token travels in the environment) ----------

  @Public()
  @Post('enroll')
  enroll(@Body() body: EnrollDto) {
    return this.enrollment.enroll(body.token);
  }

  @Public()
  @Get('install.sh')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  getInstallSh() {
    return installSh();
  }

  @Public()
  @Get('install.ps1')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  getInstallPs1() {
    return installPs1();
  }

  @Public()
  @Get('uninstall.sh')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  getUninstallSh() {
    return uninstallSh();
  }

  @Public()
  @Get('uninstall.ps1')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  getUninstallPs1() {
    return uninstallPs1();
  }

  @Public()
  @Get('agent/binary')
  getAgentBinary(
    @Query('os') os: string,
    @Query('arch') arch: string,
    @Res() res: Response,
  ) {
    const key = `${(os || '').toLowerCase()}/${(arch || '').toLowerCase()}`;
    const artifact = AGENT_ARTIFACTS[key];
    if (!artifact) throw new BadRequestException('Unknown os/arch.');
    const path = join(AGENT_DIST_DIR, artifact.file);
    if (!existsSync(path)) {
      throw new NotFoundException(
        `Agent binary for ${key} is not available on this server yet. Build it (agent/) and place it in ${AGENT_DIST_DIR}.`,
      );
    }
    res.setHeader('Content-Type', artifact.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.download}"`);
    res.sendFile(path);
  }

  @Public()
  @Get('cli/binary')
  getCliBinary(@Query('os') os: string, @Query('arch') arch: string, @Res() res: Response) {
    const key = `${(os || '').toLowerCase()}/${(arch || '').toLowerCase()}`;
    const artifact = CLI_ARTIFACTS[key];
    if (!artifact) throw new BadRequestException('Unknown os/arch.');
    const path = join(CLI_DIST_DIR, artifact.file);
    if (!existsSync(path)) {
      throw new NotFoundException(
        `The cerebro CLI for ${key} is not available on this server yet. Build it (cli/) and place it in ${CLI_DIST_DIR}.`,
      );
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.download}"`);
    res.sendFile(path);
  }
}
