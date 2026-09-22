import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  NotFoundException,
  Param,
  Patch,
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
import { FabricCaService } from './fabric-ca.service';
import { FabricUpdateSigningService } from './fabric-update-signing.service';
import { FabricEnrollmentService } from './fabric-enrollment.service';
import { FabricApprovalService } from './fabric-approval.service';
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

  /** "endpoint" (default) or "waypoint" (a network gateway). */
  @IsOptional()
  @IsString()
  mode?: string;
}

/** Create/edit a Waypoint route (curated LAN target). */
class RouteDto {
  @IsString()
  @MaxLength(8)
  kind!: string; // ssh | rdp | vnc | web

  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  group?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  secretRef?: string;

  /** Remote Browser only: the internal URL the remote browser opens. */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  webUrl?: string;
}

class EnrollDto {
  @IsString()
  token!: string;
}

class UpdateAgentDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  /** Waypoint only: CIDR/IP ranges permitted for ad-hoc connections. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  egressCidrs?: string[];

  /** Four-eyes: require approval for every session through this agent. */
  @IsOptional()
  @IsBoolean()
  requireApproval?: boolean;
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

class CaAutoTrustDto {
  @IsBoolean()
  enabled!: boolean;
}

class CaSignDto {
  @IsString()
  @MaxLength(8192)
  publicKey!: string;

  @IsString()
  @MaxLength(64)
  principal!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  machine?: string;
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

// Ad-hoc connection DTOs = a connect DTO plus the target host:port (validated against
// the Waypoint's egress ranges server-side).
class AdhocSshDto extends SshConnectDto {
  @IsString()
  @MaxLength(255)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;
}

class AdhocRdpDto extends RdpConnectDto {
  @IsString()
  @MaxLength(255)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;
}

class AdhocVncDto extends VncConnectDto {
  @IsString()
  @MaxLength(255)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;
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
    private readonly ca: FabricCaService,
    private readonly updateSigning: FabricUpdateSigningService,
    private readonly enrollment: FabricEnrollmentService,
    private readonly approvals: FabricApprovalService,
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

  @Patch('agents/:id')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  updateAgent(@Param('id') id: string, @Body() body: UpdateAgentDto, @CurrentUser() user: SessionUser) {
    return this.fabric.updateAgent(id, body, user);
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

  /** Re-push the uninstall to a pending-removal agent that's online now. */
  @Post('agents/:id/uninstall/retry')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  retryUninstall(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.fabric.retryUninstall(id, user);
  }

  /** Force-remove a tombstoned agent's row without waiting for an uninstall ack. */
  @Delete('agents/:id/force')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  async forceRemoveAgent(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    await this.fabric.forceRemoveAgent(id, user);
    return { ok: true };
  }

  // --- Four-eyes session approvals -------------------------------------------

  /** Pending session requests awaiting approval (for approvers). */
  @Get('approvals')
  @SessionOnly()
  @RequirePermissions('fabric:approve')
  listApprovals() {
    return this.approvals.listPending();
  }

  /** The requester's own poll for a held request (returns the ticket once approved). */
  @Get('approvals/:id')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  approvalStatus(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.approvals.status(id, user);
  }

  @Post('approvals/:id/approve')
  @SessionOnly()
  @RequirePermissions('fabric:approve')
  approve(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.approvals.approve(id, user);
  }

  @Post('approvals/:id/deny')
  @SessionOnly()
  @RequirePermissions('fabric:approve')
  deny(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.approvals.deny(id, user);
  }

  // --- Waypoint routes (curated LAN targets) -----------------------------

  @Post('agents/:id/routes')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  createRoute(@Param('id') id: string, @Body() body: RouteDto, @CurrentUser() user: SessionUser) {
    return this.fabric.createRoute(id, body, user);
  }

  @Patch('agents/:id/routes/:targetId')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  updateRoute(
    @Param('id') id: string,
    @Param('targetId') targetId: string,
    @Body() body: RouteDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.fabric.updateRoute(id, targetId, body, user);
  }

  @Delete('agents/:id/routes/:targetId')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  deleteRoute(
    @Param('id') id: string,
    @Param('targetId') targetId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.fabric.deleteRoute(id, targetId, user);
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

  // --- Ad-hoc connections (Waypoint → any in-range IP:port) ------------------------

  @Post('agents/:id/adhoc/ssh-session')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  openAdhocSsh(@Param('id') id: string, @Body() body: AdhocSshDto, @CurrentUser() user: SessionUser) {
    const { host, port, ...input } = body;
    return this.fabric.openAdhocSshSession(id, { host, port }, input, user);
  }

  @Post('agents/:id/adhoc/rdp-session')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  openAdhocRdp(@Param('id') id: string, @Body() body: AdhocRdpDto, @CurrentUser() user: SessionUser) {
    const { host, port, ...input } = body;
    return this.fabric.openAdhocRdpSession(id, { host, port }, input, user);
  }

  @Post('agents/:id/adhoc/vnc-session')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  openAdhocVnc(@Param('id') id: string, @Body() body: AdhocVncDto, @CurrentUser() user: SessionUser) {
    const { host, port, ...input } = body;
    return this.fabric.openAdhocVncSession(id, { host, port }, input, user);
  }

  /** Launch a Remote Browser (remote browser) for a `web` route. */
  @Post('agents/:id/targets/:targetId/remote-browser-session')
  @SessionOnly()
  @RequirePermissions('fabric:connect')
  openRemoteBrowser(@Param('id') id: string, @Param('targetId') targetId: string, @CurrentUser() user: SessionUser) {
    return this.fabric.openRemoteBrowserSession(id, targetId, user);
  }

  // --- SSH certificate authority ---------------------------------------------

  /** CA status + public key + host-trust snippets. */
  @Get('ca')
  @RequirePermissions('fabric:read')
  caStatus() {
    return this.ca.status();
  }

  /** Generate the CA keypair (idempotent). */
  @Post('ca/enable')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  caEnable(@CurrentUser() user: SessionUser) {
    return this.ca.enable(user);
  }

  /** Remove the CA keypair (existing host trust becomes orphaned). */
  @Post('ca/disable')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  async caDisable(@CurrentUser() user: SessionUser) {
    await this.ca.disable(user);
    return { ok: true };
  }

  /** Toggle auto-trusting new agents on first connect. */
  @Post('ca/auto-trust')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  caAutoTrust(@Body() body: CaAutoTrustDto, @CurrentUser() user: SessionUser) {
    return this.ca.setAutoTrust(!!body.enabled, user);
  }

  /** Sign a public key into a short-lived user cert (usable by the CLI via token). */
  @Post('ca/sign')
  @RequirePermissions('fabric:connect')
  caSign(@Body() body: CaSignDto, @CurrentUser() user: SessionUser) {
    return this.ca.sign(body.publicKey, body.principal, user, body.machine);
  }

  /** Have an online agent install + trust the CA in its sshd config (opt-in). */
  @Post('agents/:id/trust-ca')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  async trustCa(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    const pub = await this.ca.publicKey();
    if (!pub) throw new BadRequestException('Enable the SSH CA first (Fabric → SSH CA).');
    const r = await this.fabric.installCaOnAgent(id, pub, user);
    if (!r.online) throw new BadRequestException('Agent is offline — connect it and try again.');
    return { ok: true };
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

  /** Detached ed25519 signature (base64) over the agent binary's sha256, verified
   *  by the agent against its pinned key before a self-update. 404 when signing is
   *  off (or, offline mode, no signature uploaded for this exact binary). */
  @Public()
  @Get('agent/binary.sig')
  async getAgentBinarySig(@Query('os') os: string, @Query('arch') arch: string, @Res() res: Response) {
    const key = `${(os || '').toLowerCase()}/${(arch || '').toLowerCase()}`;
    const artifact = AGENT_ARTIFACTS[key];
    if (!artifact) throw new BadRequestException('Unknown os/arch.');
    const path = join(AGENT_DIST_DIR, artifact.file);
    if (!existsSync(path)) throw new NotFoundException('Agent binary not available.');
    const sig = await this.updateSigning.signatureForBinary(path);
    if (!sig) throw new NotFoundException('No signature available.');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(sig);
  }

  // ── Agent-update signing (H3) ──────────────────────────────────────────────
  @Get('update-signing')
  @SessionOnly()
  @RequirePermissions('fabric:read')
  updateSigningStatus() {
    return this.updateSigning.status();
  }

  /** Generate the signing key (vault mode). */
  @Post('update-signing/enable')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  enableUpdateSigning(@Body() body: { regenerate?: boolean }, @CurrentUser() user: SessionUser) {
    return this.updateSigning.generate(user, !!body?.regenerate);
  }

  /** Offline mode: import an externally-generated public key (base64 raw ed25519). */
  @Post('update-signing/import')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  importUpdateSigningKey(@Body() body: { publicKey: string }, @CurrentUser() user: SessionUser) {
    return this.updateSigning.importPublicKey(body?.publicKey ?? '', user);
  }

  /** Offline mode: upload a signature (base64) for a binary's sha256 (hex). */
  @Post('update-signing/offline-signature')
  @SessionOnly()
  @RequirePermissions('fabric:manage')
  async uploadOfflineSignature(@Body() body: { sha256: string; signature: string }, @CurrentUser() user: SessionUser) {
    await this.updateSigning.storeOfflineSignature(body?.sha256 ?? '', body?.signature ?? '', user);
    return { ok: true };
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
