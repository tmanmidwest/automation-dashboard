import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { existsSync } from 'fs';
import { join } from 'path';
import type { Agent, AgentTarget } from '@prisma/client';
import type {
  FabricAgentDto,
  FabricEnrollmentDto,
  FabricProbeResult,
  FabricRdpConnectInput,
  FabricSessionDto,
  FabricSessionTicket,
  FabricSshConnectInput,
  FabricTargetDto,
  FabricVncConnectInput,
  FabricVncSessionTicket,
  RdpCredential,
  SessionUser,
  SshCredential,
  VncCredential,
} from '@cerebro/shared';

/** Structured Fabric credential kinds that live in the vault. */
type FabricCredKind = 'ssh' | 'rdp' | 'vnc';
type FabricCredValue = SshCredential | RdpCredential | VncCredential;
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { SecretsService } from '../secrets/secrets.service';
import { AgentRegistryService } from './agent-registry.service';
import { FabricSessionService } from './fabric-session.service';
import { FabricGuacService } from './fabric-guac.service';
import { generateEnrollToken } from './fabric-credentials';
import { baseUrl } from './fabric-enrollment.service';
import { fabricConfig } from './fabric-config';

const SESSION_WS_PATH = '/api/fabric/session/ws';

const ENROLL_TTL_MS = 60 * 60 * 1000; // 1h to run the installer

/** Management surface for the /fabric screen (session-gated). */
@Injectable()
export class FabricService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: AgentRegistryService,
    private readonly sessions: FabricSessionService,
    private readonly guac: FabricGuacService,
    private readonly secrets: SecretsService,
  ) {}

  /**
   * One-time backfill: give existing per-machine Fabric credentials a label that
   * names the machine (older ones were labelled "SSH · 127.0.0.1:22" with an
   * opaque agent id, indistinguishable in the vault). Idempotent.
   */
  async onModuleInit(): Promise<void> {
    try {
      for (const s of await this.secrets.list()) {
        if ((s.kind !== 'ssh' && s.kind !== 'rdp' && s.kind !== 'vnc') || !s.key.startsWith('fabric/')) continue;
        const patch: { category?: 'fabric'; label?: string; description?: string } = {};
        if (s.category !== 'fabric') patch.category = 'fabric';

        // Per-target credentials: relabel with the machine name.
        const m = s.key.match(/^fabric\/([^/]+)\/([^/]+)$/);
        if (m && m[1] !== 'cred') {
          const agent = await this.prisma.agent
            .findUnique({ where: { id: m[1] }, select: { name: true, hostname: true } })
            .catch(() => null);
          if (agent) {
            const kind = s.kind.toUpperCase();
            const label = `Fabric · ${agent.name} · ${kind}`;
            if (s.label !== label) {
              const target = await this.prisma.agentTarget
                .findUnique({ where: { id: m[2] }, select: { host: true, port: true } })
                .catch(() => null);
              patch.label = label;
              patch.description = `Fabric ${kind} credential for ${agent.name}${agent.hostname ? ` (${agent.hostname})` : ''}${target ? ` — ${target.host}:${target.port}` : ''}`;
            }
          }
        }
        if (Object.keys(patch).length > 0) await this.secrets.updateMeta(s.key, patch).catch(() => undefined);
      }
    } catch {
      /* best-effort */
    }
  }

  /**
   * Mint a one-time ticket for an interactive SSH session to a target. The
   * browser opens the session WebSocket with the returned token; credentials are
   * held server-side and never travel in the URL. Phase 3 = SSH only.
   */
  async openSshSession(
    agentId: string,
    targetId: string,
    input: FabricSshConnectInput,
    user: SessionUser,
  ): Promise<FabricSessionTicket> {
    const target = await this.prisma.agentTarget.findFirst({ where: { id: targetId, agentId } });
    if (!target) throw new NotFoundException('Target not found.');
    if (target.kind !== 'ssh') throw new BadRequestException('Only SSH sessions are supported yet (Phase 3).');
    if (!this.registry.isOnline(agentId)) throw new BadRequestException('Agent is offline.');

    const creds = await this.resolveSshCreds(target, input, user);

    const token = this.sessions.issue({
      agentId,
      targetId,
      userId: user.id,
      userEmail: user.email,
      host: target.host,
      port: target.port,
      kind: target.kind,
      username: creds.username,
      password: creds.password,
      privateKey: creds.privateKey,
      passphrase: creds.passphrase,
    });
    return { token, wsPath: SESSION_WS_PATH };
  }

  /**
   * Mint an encrypted guac token for an in-browser RDP session (Phase 4). Same
   * credential model as SSH: supply them, save them, or use the target's saved
   * vault credential (never seen by the operator).
   */
  async openRdpSession(
    agentId: string,
    targetId: string,
    input: FabricRdpConnectInput,
    user: SessionUser,
  ): Promise<FabricSessionTicket> {
    const target = await this.prisma.agentTarget.findFirst({ where: { id: targetId, agentId } });
    if (!target) throw new NotFoundException('Target not found.');
    if (target.kind !== 'rdp') throw new BadRequestException('This target is not an RDP endpoint.');
    if (!this.registry.isOnline(agentId)) throw new BadRequestException('Agent is offline.');

    const ref = input.secretRef || (input.useSaved ? target.secretRef : undefined);
    let creds: RdpCredential;
    if (ref) {
      creds = (await this.revealCredential(ref, 'rdp')) as RdpCredential;
    } else {
      if (!input.username?.trim()) throw new BadRequestException('A username is required.');
      if (!input.password) throw new BadRequestException('A password is required.');
      creds = { username: input.username.trim(), password: input.password, domain: input.domain };
      if (input.save) {
        this.requireManage(user);
        if (input.saveAs?.trim()) await this.saveNamedCredential('rdp', input.saveAs.trim(), creds, user);
        else await this.saveTargetCredential(target, 'rdp', creds, user);
      }
    }

    return this.guac.issue({
      agentId,
      targetId,
      userId: user.id,
      userEmail: user.email,
      host: target.host,
      port: target.port,
      username: creds.username,
      password: creds.password,
      domain: creds.domain,
      width: input.width,
      height: input.height,
      colorDepth: input.colorDepth,
      security: input.security,
      consoleSession: input.consoleSession,
      enableEffects: input.enableEffects,
      disableAudio: input.disableAudio,
    });
  }

  /**
   * Mint a one-time ticket for an in-browser VNC session (macOS Screen Sharing
   * or any VNC). noVNC speaks RFB straight through the tunnel to :5900; the VNC
   * password (if any) is handled client-side by noVNC.
   */
  async openVncSession(
    agentId: string,
    targetId: string,
    input: FabricVncConnectInput,
    user: SessionUser,
  ): Promise<FabricVncSessionTicket> {
    const target = await this.prisma.agentTarget.findFirst({ where: { id: targetId, agentId } });
    if (!target) throw new NotFoundException('Target not found.');
    if (target.kind !== 'vnc') throw new BadRequestException('This target is not a VNC endpoint.');
    if (!this.registry.isOnline(agentId)) throw new BadRequestException('Agent is offline.');

    // Resolve a credential the same way as SSH/RDP — but VNC auth runs in the
    // browser (noVNC), so the resolved value is returned to the viewer rather
    // than used server-side. With no saved/entered credential, noVNC prompts.
    const ref = input.secretRef || (input.useSaved ? target.secretRef : undefined);
    let creds: VncCredential | undefined;
    if (ref) {
      creds = (await this.revealCredential(ref, 'vnc')) as VncCredential;
    } else if (input.password) {
      creds = { username: input.username?.trim() || undefined, password: input.password };
      if (input.save) {
        this.requireManage(user);
        if (input.saveAs?.trim()) await this.saveNamedCredential('vnc', input.saveAs.trim(), creds, user);
        else await this.saveTargetCredential(target, 'vnc', creds, user);
      }
    }

    const token = this.sessions.issue({
      agentId,
      targetId,
      userId: user.id,
      userEmail: user.email,
      host: target.host,
      port: target.port,
      kind: 'vnc',
    });
    return { token, wsPath: SESSION_WS_PATH, username: creds?.username, password: creds?.password };
  }

  /** Push the SSH CA public key to an online agent to install into its sshd trust. */
  async installCaOnAgent(agentId: string, caPublicKey: string, user: SessionUser): Promise<{ online: boolean }> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new NotFoundException('Agent not found.');
    const online = this.registry.requestInstallCa(agentId, caPublicKey);
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.ca.host_trust_requested',
      target: agentId,
      meta: { name: agent.name, online },
    });
    return { online };
  }

  /** Clear a target's pinned SSH host key (e.g. after the host was rebuilt). */
  async clearHostKey(agentId: string, targetId: string, user: SessionUser): Promise<void> {
    const target = await this.prisma.agentTarget.findFirst({ where: { id: targetId, agentId } });
    if (!target) throw new NotFoundException('Target not found.');
    await this.prisma.agentTarget.update({ where: { id: target.id }, data: { hostKey: null } });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.hostkey.cleared',
      target: agentId,
      meta: { targetId },
    });
  }

  /**
   * Resolve SSH credentials for a target from the connect input — a specific vault
   * credential (secretRef), the target's own saved credential (useSaved), or
   * manually-entered fields (optionally saved to the vault). Shared by the SSH
   * terminal and the SFTP file browser.
   */
  async resolveSshCreds(
    target: AgentTarget,
    input: FabricSshConnectInput,
    user: SessionUser,
  ): Promise<SshCredential> {
    const ref = input.secretRef || (input.useSaved ? target.secretRef : undefined);
    if (ref) return (await this.revealCredential(ref, 'ssh')) as SshCredential;

    if (!input.username?.trim()) throw new BadRequestException('A username is required.');
    if (!input.password && !input.privateKey) throw new BadRequestException('Provide a password or a private key.');
    const creds: SshCredential = {
      username: input.username.trim(),
      password: input.password,
      privateKey: input.privateKey,
      passphrase: input.passphrase,
    };
    if (input.save) {
      this.requireManage(user);
      if (input.saveAs?.trim()) await this.saveNamedCredential('ssh', input.saveAs.trim(), creds, user);
      else await this.saveTargetCredential(target, 'ssh', creds, user);
    }
    return creds;
  }

  private requireManage(user: SessionUser): void {
    if (!user.permissions.includes('fabric:manage')) {
      throw new ForbiddenException('Saving a credential to the vault requires fabric:manage.');
    }
  }

  /**
   * List reusable vault credentials of a kind (ssh/rdp) for the connect-dialog
   * picker: named credentials (`fabric/cred/*`) and any non-Fabric ones, but not
   * other machines' per-target entries (`fabric/<agentId>/<targetId>`), which are
   * machine-specific and would clutter the list with ambiguous labels.
   */
  async listCredentials(kind: FabricCredKind): Promise<{ key: string; label: string }[]> {
    const all = await this.secrets.list();
    return all
      .filter((s) => s.kind === kind)
      .filter((s) => !s.key.startsWith('fabric/') || s.key.startsWith('fabric/cred/'))
      .map((s) => ({ key: s.key, label: s.label }));
  }

  /** Reveal + parse a vault credential, verifying it is of the expected kind. */
  private async revealCredential(key: string, kind: FabricCredKind): Promise<FabricCredValue> {
    const meta = await this.prisma.secretMeta.findUnique({ where: { key }, select: { kind: true } });
    if (!meta || meta.kind !== kind) {
      throw new BadRequestException(`That vault entry is not an ${kind.toUpperCase()} credential.`);
    }
    const raw = await this.secrets.reveal(key);
    if (!raw) throw new BadRequestException('The credential is missing from the vault.');
    return JSON.parse(raw) as FabricCredValue;
  }

  /** Save a named, reusable credential (not tied to one machine) in the vault. */
  private async saveNamedCredential(
    kind: FabricCredKind,
    name: string,
    value: FabricCredValue,
    user: SessionUser,
  ): Promise<void> {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'cred';
    const key = `fabric/cred/${slug}`;
    await this.secrets.set(
      key,
      JSON.stringify(value),
      { kind, category: 'fabric', label: name, description: `Fabric ${kind.toUpperCase()} credential (reusable)` },
      { actorId: user.id, actorEmail: user.email },
    );
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.credential_saved',
      target: key,
      meta: { kind, name },
    });
  }

  /** Store a target credential (SSH or RDP) in the vault and attach it to the target. */
  private async saveTargetCredential(
    target: AgentTarget,
    kind: FabricCredKind,
    value: FabricCredValue,
    user: SessionUser,
  ): Promise<void> {
    const key = `fabric/${target.agentId}/${target.id}`;
    const agent = await this.prisma.agent.findUnique({
      where: { id: target.agentId },
      select: { name: true, hostname: true },
    });
    const machine = agent?.name || target.agentId;
    await this.secrets.set(
      key,
      JSON.stringify(value),
      {
        kind,
        category: 'fabric',
        label: `Fabric · ${machine} · ${kind.toUpperCase()}`,
        description: `Fabric ${kind.toUpperCase()} credential for ${machine}${agent?.hostname ? ` (${agent.hostname})` : ''} — ${target.host}:${target.port}`,
      },
      { actorId: user.id, actorEmail: user.email },
    );
    await this.prisma.agentTarget.update({ where: { id: target.id }, data: { secretRef: key } });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.target.credential_saved',
      target: target.agentId,
      meta: { targetId: target.id, kind },
    });
  }

  /** Remove a target's vault credential (and detach it). */
  async clearTargetCredential(agentId: string, targetId: string, user: SessionUser): Promise<void> {
    const target = await this.prisma.agentTarget.findFirst({ where: { id: targetId, agentId } });
    if (!target) throw new NotFoundException('Target not found.');
    if (target.secretRef) {
      await this.secrets.remove(target.secretRef, { actorId: user.id, actorEmail: user.email }).catch(() => undefined);
      await this.prisma.agentTarget.update({ where: { id: target.id }, data: { secretRef: null } });
    }
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.target.credential_cleared',
      target: agentId,
      meta: { targetId },
    });
  }

  /** Operator-tunable cadences the web UI reads (poll interval, heartbeat). */
  clientConfig(): { pollMs: number; heartbeatMs: number } {
    return { pollMs: fabricConfig.pollMs, heartbeatMs: fabricConfig.heartbeatMs };
  }

  /** All agents with their targets, statuses reconciled against live connections. */
  async listAgents(): Promise<FabricAgentDto[]> {
    const agents = await this.prisma.agent.findMany({
      include: { targets: { orderBy: [{ kind: 'asc' }, { port: 'asc' }] } },
      orderBy: { createdAt: 'desc' },
    });
    return agents.map((a) => this.toAgentDto(a, a.targets));
  }

  /**
   * Register a new machine: create a pending agent and mint a one-time
   * enrollment token. Returns the token (shown once) plus copy-paste installers.
   */
  async createAgent(
    input: { name: string; os?: string | null; tags?: string[] },
    user: SessionUser,
  ): Promise<FabricEnrollmentDto> {
    const enroll = generateEnrollToken();
    const expires = new Date(Date.now() + ENROLL_TTL_MS);
    const agent = await this.prisma.agent.create({
      data: {
        name: input.name.trim() || 'Unnamed machine',
        os: input.os ?? null,
        tags: input.tags ?? [],
        status: 'pending',
        enrollHash: enroll.hash,
        enrollExpires: expires,
      },
      include: { targets: true },
    });

    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.agent.created',
      target: agent.id,
      meta: { name: agent.name, os: agent.os },
    });

    const url = baseUrl();
    return {
      agent: this.toAgentDto(agent, agent.targets),
      enrollToken: enroll.plaintext,
      enrollExpiresAt: expires.toISOString(),
      url,
      installLinux: `curl -fsSL ${url}/api/fabric/install.sh | sudo CEREBRO_URL=${url} ENROLL=${enroll.plaintext} sh`,
      installWindows: `$env:CEREBRO_URL='${url}'; $env:ENROLL='${enroll.plaintext}'; iwr ${url}/api/fabric/install.ps1 -UseBasicParsing | iex`,
    };
  }

  /** Revoke an agent: kill its credential and drop any live connection. */
  async revokeAgent(id: string, user: SessionUser): Promise<FabricAgentDto> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) throw new NotFoundException('Agent not found.');
    this.registry.disconnect(id);
    const updated = await this.prisma.agent.update({
      where: { id },
      data: { status: 'revoked', credPrefix: null, credHash: null, enrollHash: null, enrollExpires: null },
      include: { targets: true },
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.agent.revoked',
      target: id,
      meta: { name: agent.name },
    });
    return this.toAgentDto(updated, updated.targets);
  }

  /** Delete an agent and its history. */
  async deleteAgent(id: string, user: SessionUser): Promise<void> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) throw new NotFoundException('Agent not found.');
    // If it's online, ask it to uninstall itself before we drop it; otherwise
    // just disconnect (a manual uninstall on the box is then needed).
    if (!this.registry.requestUninstall(id)) this.registry.disconnect(id);
    // Remove any vault credentials attached to this agent's targets so they
    // don't outlive the agent as orphans.
    const withSecrets = await this.prisma.agentTarget.findMany({
      where: { agentId: id, secretRef: { not: null } },
      select: { secretRef: true },
    });
    for (const t of withSecrets) {
      if (t.secretRef) await this.secrets.remove(t.secretRef, { actorId: user.id, actorEmail: user.email }).catch(() => undefined);
    }
    await this.prisma.agent.delete({ where: { id } });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.agent.deleted',
      target: id,
      meta: { name: agent.name },
    });
  }

  async listSessions(agentId?: string): Promise<FabricSessionDto[]> {
    const rows = await this.prisma.fabricSession.findMany({
      where: agentId ? { agentId } : undefined,
      include: { agent: { select: { name: true } } },
      orderBy: { startedAt: 'desc' },
      take: 200,
    });
    return rows.map((s) => ({
      id: s.id,
      agentId: s.agentId,
      agentName: s.agent?.name,
      targetKind: s.targetKind as FabricSessionDto['targetKind'],
      userId: s.userId,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt?.toISOString() ?? null,
      bytesUp: Number(s.bytesUp),
      bytesDown: Number(s.bytesDown),
      hasRecording: !!s.recordPath,
    }));
  }

  /** Absolute path of a session's recording file, or null if none exists. */
  async recordingPath(sessionId: string): Promise<string | null> {
    const s = await this.prisma.fabricSession.findUnique({
      where: { id: sessionId },
      select: { recordPath: true },
    });
    if (!s?.recordPath) return null;
    const dir = process.env.FABRIC_RECORDING_DIR || '/recordings';
    const file = join(dir, s.recordPath);
    return existsSync(file) ? file : null;
  }

  /**
   * Prove the tunnel end-to-end: open a stream to the target through the agent,
   * measure the connect, and capture the first line the target speaks (an SSH
   * banner, say). Exercises the whole data path — broker → agent → 127.0.0.1 →
   * back — without needing a browser terminal. This is the Phase-2 check.
   */
  async probeTarget(agentId: string, targetId: string, user: SessionUser): Promise<FabricProbeResult> {
    const target = await this.prisma.agentTarget.findFirst({ where: { id: targetId, agentId } });
    if (!target) throw new NotFoundException('Target not found.');
    if (!this.registry.isOnline(agentId)) return { ok: false, error: 'Agent is offline.' };

    const start = Date.now();
    let stream;
    try {
      stream = await this.registry.openStream(agentId, target.host, target.port);
    } catch (e) {
      const error = e instanceof Error ? e.message : 'tunnel failed';
      await this.audit.record({
        actorId: user.id,
        actorEmail: user.email,
        action: 'fabric.tunnel.probe',
        target: agentId,
        meta: { targetId, kind: target.kind, port: target.port, ok: false, error },
      });
      return { ok: false, latencyMs: Date.now() - start, error };
    }
    const latencyMs = Date.now() - start;

    // Read whatever the target volunteers on connect for up to ~800ms. Servers
    // that speak first (SSH) give a banner; ones that wait (RDP) just confirm the
    // TCP path is live.
    const banner = await new Promise<string | undefined>((resolve) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const firstLine = () => {
        const text = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
        const printable = text.replace(/[^\x20-\x7e]/g, '').trim();
        return printable || undefined;
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stream.close();
        resolve(firstLine());
      };
      const timer = setTimeout(finish, 800);
      timer.unref?.();
      stream.onData = (d: Buffer) => {
        chunks.push(d);
        if (Buffer.concat(chunks).includes(0x0a) || Buffer.concat(chunks).length >= 256) finish();
      };
      stream.onClose = finish;
    });

    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.tunnel.probe',
      target: agentId,
      meta: { targetId, kind: target.kind, port: target.port, ok: true, latencyMs },
    });
    return { ok: true, latencyMs, banner };
  }

  private toAgentDto(agent: Agent, targets: AgentTarget[]): FabricAgentDto {
    return {
      id: agent.id,
      name: agent.name,
      hostname: agent.hostname,
      os: agent.os,
      osVersion: agent.osVersion,
      agentVersion: agent.agentVersion,
      tags: agent.tags,
      status: this.registry.statusOf(agent.id, agent.status),
      lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
      createdAt: agent.createdAt.toISOString(),
      caTrusted: !!agent.caTrustedAt,
      targets: targets.map(
        (t): FabricTargetDto => ({
          id: t.id,
          kind: t.kind as FabricTargetDto['kind'],
          host: t.host,
          port: t.port,
          label: t.label,
          hasCredential: !!t.secretRef,
          hostKeyPinned: !!t.hostKey,
        }),
      ),
    };
  }
}
