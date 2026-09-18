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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, Public, RequirePermissions, SessionOnly } from '../auth/decorators';
import type { SessionUser } from '@cerebro/shared';
import { FabricService } from './fabric.service';
import { FabricEnrollmentService } from './fabric-enrollment.service';
import { installPs1, installSh } from './agent-installers';

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
}

class RdpConnectDto {
  @IsOptional()
  @IsBoolean()
  useSaved?: boolean;

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

/** Where prebuilt agent binaries are served from (populated by CI / a release step). */
const AGENT_DIST_DIR = process.env.FABRIC_AGENT_DIST_DIR || '/app/agent-dist';
const AGENT_ARTIFACTS: Record<string, { file: string; contentType: string; download: string }> = {
  'linux/amd64': { file: 'cerebro-agent-linux-amd64', contentType: 'application/octet-stream', download: 'cerebro-agent' },
  'linux/arm64': { file: 'cerebro-agent-linux-arm64', contentType: 'application/octet-stream', download: 'cerebro-agent' },
  'windows/amd64': { file: 'cerebro-agent-windows-amd64.exe', contentType: 'application/octet-stream', download: 'cerebro-agent.exe' },
};

@Controller('api/fabric')
export class FabricController {
  constructor(
    private readonly fabric: FabricService,
    private readonly enrollment: FabricEnrollmentService,
  ) {}

  // --- Management (session-gated) --------------------------------------------

  @Get('agents')
  @RequirePermissions('fabric:read')
  listAgents() {
    return this.fabric.listAgents();
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
}
