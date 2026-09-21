import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { existsSync } from 'fs';
import { BlockList, isIP } from 'net';
import { join } from 'path';
import type { Agent, AgentTarget } from '@prisma/client';
import type {
  FabricAgentDto,
  FabricAgentMode,
  FabricApprovalPending,
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

/** Create/edit input for a route (kind validated at runtime in normalizeRoute). */
type RouteInput = {
  kind: string;
  host?: string;
  port?: number;
  label?: string;
  group?: string;
  secretRef?: string;
  webUrl?: string;
};

/** Structured Fabric credential kinds that live in the vault. */
type FabricCredKind = 'ssh' | 'rdp' | 'vnc';
type FabricCredValue = SshCredential | RdpCredential | VncCredential;
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { SecretsService } from '../secrets/secrets.service';
import { AgentRegistryService } from './agent-registry.service';
import { FabricSessionService } from './fabric-session.service';
import { FabricGuacService } from './fabric-guac.service';
import { RemoteBrowserService } from './remote-browser.service';
import { FabricApprovalService } from './fabric-approval.service';
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
    private readonly remoteBrowser: RemoteBrowserService,
    private readonly approvals: FabricApprovalService,
  ) {}

  /**
   * Four-eyes gate: if the agent requires approval, hold the (already-resolved)
   * session as a pending request and return a handle the client polls; otherwise
   * mint it immediately. The `mint` closure captures the resolved target + creds,
   * so nothing sensitive is persisted while a request waits.
   */
  private async gate<T extends FabricSessionTicket>(
    agentId: string,
    meta: { kind: string; host: string; port: number; label?: string | null; url?: string | null },
    user: SessionUser,
    mint: () => Promise<T>,
  ): Promise<T | FabricApprovalPending> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { requireApproval: true, name: true, mode: true },
    });
    if (!agent?.requireApproval) return mint();
    const approvalId = await this.approvals.request(
      {
        agentId,
        agentName: agent.name,
        agentMode: (agent.mode as FabricAgentMode) ?? 'endpoint',
        kind: meta.kind,
        target: meta.url || `${meta.host}:${meta.port}`,
        user,
      },
      mint,
    );
    return { pending: true, approvalId };
  }

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
  ): Promise<FabricSessionTicket | FabricApprovalPending> {
    const target = await this.resolveStoredTarget(agentId, targetId, 'ssh');
    return this.gate(agentId, { kind: 'ssh', host: target.host, port: target.port, label: target.label }, user, () =>
      this.issueSshSession(agentId, target, input, user),
    );
  }

  /** Ad-hoc SSH connection to an in-range IP:port through a Waypoint (Phase 2). */
  async openAdhocSshSession(
    agentId: string,
    adhoc: { host: string; port: number },
    input: FabricSshConnectInput,
    user: SessionUser,
  ): Promise<FabricSessionTicket | FabricApprovalPending> {
    const target = await this.resolveAdhocTarget(agentId, 'ssh', adhoc);
    return this.gate(agentId, { kind: 'ssh', host: target.host, port: target.port }, user, () =>
      this.issueSshSession(agentId, target, input, user),
    );
  }

  private async issueSshSession(
    agentId: string,
    target: AgentTarget,
    input: FabricSshConnectInput,
    user: SessionUser,
  ): Promise<FabricSessionTicket> {
    const creds = await this.resolveSshCreds(target, input, user);
    const token = this.sessions.issue({
      agentId,
      targetId: target.id,
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
  ): Promise<FabricSessionTicket | FabricApprovalPending> {
    const target = await this.resolveStoredTarget(agentId, targetId, 'rdp');
    return this.gate(agentId, { kind: 'rdp', host: target.host, port: target.port, label: target.label }, user, () =>
      this.issueRdpSession(agentId, target, input, user),
    );
  }

  /** Ad-hoc RDP connection to an in-range IP:port through a Waypoint (Phase 2). */
  async openAdhocRdpSession(
    agentId: string,
    adhoc: { host: string; port: number },
    input: FabricRdpConnectInput,
    user: SessionUser,
  ): Promise<FabricSessionTicket | FabricApprovalPending> {
    const target = await this.resolveAdhocTarget(agentId, 'rdp', adhoc);
    return this.gate(agentId, { kind: 'rdp', host: target.host, port: target.port }, user, () =>
      this.issueRdpSession(agentId, target, input, user),
    );
  }

  private async issueRdpSession(
    agentId: string,
    target: AgentTarget,
    input: FabricRdpConnectInput,
    user: SessionUser,
  ): Promise<FabricSessionTicket> {
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
      targetId: target.id,
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
  ): Promise<FabricVncSessionTicket | FabricApprovalPending> {
    const target = await this.resolveStoredTarget(agentId, targetId, 'vnc');
    return this.gate(agentId, { kind: 'vnc', host: target.host, port: target.port, label: target.label }, user, () =>
      this.issueVncSession(agentId, target, input, user),
    );
  }

  /** Ad-hoc VNC connection to an in-range IP:port through a Waypoint (Phase 2). */
  async openAdhocVncSession(
    agentId: string,
    adhoc: { host: string; port: number },
    input: FabricVncConnectInput,
    user: SessionUser,
  ): Promise<FabricVncSessionTicket | FabricApprovalPending> {
    const target = await this.resolveAdhocTarget(agentId, 'vnc', adhoc);
    return this.gate(agentId, { kind: 'vnc', host: target.host, port: target.port }, user, () =>
      this.issueVncSession(agentId, target, input, user),
    );
  }

  private async issueVncSession(
    agentId: string,
    target: AgentTarget,
    input: FabricVncConnectInput,
    user: SessionUser,
  ): Promise<FabricVncSessionTicket> {
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
      targetId: target.id,
      userId: user.id,
      userEmail: user.email,
      host: target.host,
      port: target.port,
      kind: 'vnc',
    });
    return { token, wsPath: SESSION_WS_PATH, username: creds?.username, password: creds?.password };
  }

  /**
   * Launch a Remote Browser: an ephemeral remote browser (streamed over VNC) whose
   * traffic is proxied through the Waypoint to an internal web app. Returns a
   * one-time VNC ticket the browser opens against the Remote Browser relay.
   */
  async openRemoteBrowserSession(
    agentId: string,
    targetId: string,
    user: SessionUser,
  ): Promise<FabricSessionTicket | FabricApprovalPending> {
    const target = await this.prisma.agentTarget.findFirst({ where: { id: targetId, agentId } });
    if (!target) throw new NotFoundException('Target not found.');
    if (target.kind !== 'web' || !target.webUrl) throw new BadRequestException('This target is not a Remote Browser.');
    if (!this.registry.isOnline(agentId)) throw new BadRequestException('Waypoint is offline.');
    const webUrl = target.webUrl;
    return this.gate(
      agentId,
      { kind: 'web', host: target.host, port: target.port, url: webUrl },
      user,
      () => this.remoteBrowser.launch({ agentId, targetId, url: webUrl, host: target.host, port: target.port, user }),
    );
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

  /** Resolve a stored route/endpoint by id, asserting kind + online. */
  private async resolveStoredTarget(
    agentId: string,
    targetId: string,
    kind: FabricCredKind,
  ): Promise<AgentTarget> {
    const target = await this.prisma.agentTarget.findFirst({ where: { id: targetId, agentId } });
    if (!target) throw new NotFoundException('Target not found.');
    if (target.kind !== kind) throw new BadRequestException(`This target is not a ${kind.toUpperCase()} endpoint.`);
    if (!this.registry.isOnline(agentId)) throw new BadRequestException('Agent is offline.');
    return target;
  }

  /**
   * Synthesize a non-persistent target for an ad-hoc connection (Phase 2): the host must
   * be a literal IP inside one of the Waypoint's egress CIDR ranges. No AgentTarget
   * row is created — the session is audited by host:port and its SSH host key is
   * accepted (not persistently pinned) since there is no target to pin against.
   */
  private async resolveAdhocTarget(
    agentId: string,
    kind: FabricCredKind,
    adhoc: { host: string; port: number },
  ): Promise<AgentTarget> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new NotFoundException('Agent not found.');
    if (agent.mode !== 'waypoint') throw new BadRequestException('Ad-hoc connections require a Waypoint.');
    if (!this.registry.isOnline(agentId)) throw new BadRequestException('Waypoint is offline.');
    const host = (adhoc.host || '').trim();
    const port = Number(adhoc.port);
    if (!isIP(host)) throw new BadRequestException('Ad-hoc connections require a literal IP address.');
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new BadRequestException('Invalid port.');
    if (!agent.egressCidrs?.length) {
      throw new BadRequestException('This Waypoint has no ad-hoc egress ranges configured.');
    }
    if (!this.ipInCidrs(host, agent.egressCidrs)) {
      throw new BadRequestException(`${host} is not within this Waypoint's egress ranges.`);
    }
    return {
      id: '',
      agentId,
      kind,
      host,
      port,
      label: null,
      secretRef: null,
      hostKey: null,
      source: 'adhoc',
      group: null,
      webUrl: null,
    } as AgentTarget;
  }

  /** Validate + normalize CIDR strings (a bare IP becomes /32 or /128). */
  private normalizeCidrs(list: string[]): string[] {
    const out: string[] = [];
    for (const raw of list) {
      const v = (raw || '').trim();
      if (!v) continue;
      const [addr, bitsStr] = v.split('/');
      const fam = isIP(addr);
      if (!fam) throw new BadRequestException(`Invalid CIDR/IP: ${v}`);
      const maxBits = fam === 6 ? 128 : 32;
      const bits = bitsStr === undefined ? maxBits : Number(bitsStr);
      if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) {
        throw new BadRequestException(`Invalid CIDR mask: ${v}`);
      }
      out.push(`${addr}/${bits}`);
    }
    return Array.from(new Set(out)).slice(0, 64);
  }

  private ipInCidrs(ip: string, cidrs: string[]): boolean {
    const fam = isIP(ip);
    if (!fam) return false;
    try {
      const bl = new BlockList();
      for (const c of cidrs) {
        const [addr, bitsStr] = c.split('/');
        bl.addSubnet(addr, Number(bitsStr), isIP(addr) === 6 ? 'ipv6' : 'ipv4');
      }
      return bl.check(ip, fam === 6 ? 'ipv6' : 'ipv4');
    } catch {
      return false;
    }
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
    if (!target.id) {
      throw new BadRequestException("Use 'Save as' to store a credential for an ad-hoc connection.");
    }
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
    input: { name: string; os?: string | null; tags?: string[]; mode?: string },
    user: SessionUser,
  ): Promise<FabricEnrollmentDto> {
    const enroll = generateEnrollToken();
    const expires = new Date(Date.now() + ENROLL_TTL_MS);
    const mode: FabricAgentDto['mode'] = input.mode === 'waypoint' ? 'waypoint' : 'endpoint';
    const agent = await this.prisma.agent.create({
      data: {
        name: input.name.trim() || (mode === 'waypoint' ? 'Unnamed Waypoint' : 'Unnamed machine'),
        os: input.os ?? null,
        tags: input.tags ?? [],
        status: 'pending',
        mode,
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
      meta: { name: agent.name, os: agent.os, mode },
    });

    const url = baseUrl();
    // A Waypoint installer passes CEREBRO_MODE=waypoint (script) / --mode waypoint
    // (service), so it uses its own service name + config dir and can coexist with
    // an endpoint agent on the same box.
    const modeEnvSh = mode === 'waypoint' ? ' CEREBRO_MODE=waypoint' : '';
    const modeEnvPs = mode === 'waypoint' ? `$env:CEREBRO_MODE='waypoint'; ` : '';
    return {
      agent: this.toAgentDto(agent, agent.targets),
      enrollToken: enroll.plaintext,
      enrollExpiresAt: expires.toISOString(),
      url,
      installLinux: `curl -fsSL ${url}/api/fabric/install.sh | sudo CEREBRO_URL=${url} ENROLL=${enroll.plaintext}${modeEnvSh} sh`,
      installWindows: `${modeEnvPs}$env:CEREBRO_URL='${url}'; $env:ENROLL='${enroll.plaintext}'; iwr ${url}/api/fabric/install.ps1 -UseBasicParsing | iex`,
    };
  }

  /** Edit an agent's display fields (name, tags, notes). */
  async updateAgent(
    id: string,
    input: { name?: string; tags?: string[]; notes?: string | null; egressCidrs?: string[]; requireApproval?: boolean },
    user: SessionUser,
  ): Promise<FabricAgentDto> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) throw new NotFoundException('Agent not found.');
    const data: {
      name?: string;
      tags?: string[];
      notes?: string | null;
      egressCidrs?: string[];
      requireApproval?: boolean;
    } = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new BadRequestException('Name cannot be empty.');
      data.name = name;
    }
    if (input.tags !== undefined) {
      data.tags = input.tags.map((t) => t.trim()).filter(Boolean).slice(0, 20);
    }
    if (input.notes !== undefined) {
      data.notes = input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null;
    }
    if (input.egressCidrs !== undefined) {
      if (agent.mode !== 'waypoint') {
        throw new BadRequestException('Egress ranges apply only to a Waypoint.');
      }
      data.egressCidrs = this.normalizeCidrs(input.egressCidrs);
    }
    if (input.requireApproval !== undefined) {
      data.requireApproval = !!input.requireApproval;
    }
    const updated = await this.prisma.agent.update({ where: { id }, data, include: { targets: true } });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.agent.updated',
      target: id,
      meta: { fields: Object.keys(data) },
    });
    // Egress ranges are part of a Waypoint's allow policy — push the change live.
    if (data.egressCidrs !== undefined) await this.registry.pushAllow(id);
    return this.toAgentDto(updated, updated.targets);
  }

  // --- Waypoint routes (curated LAN targets) -----------------------------

  private async requireWaypoint(id: string): Promise<Agent> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) throw new NotFoundException('Agent not found.');
    if (agent.mode !== 'waypoint') {
      throw new BadRequestException('Routes can only be added to a Waypoint.');
    }
    return agent;
  }

  private normalizeRoute(input: {
    kind: string;
    host?: string;
    port?: number;
    label?: string | null;
    group?: string | null;
    secretRef?: string | null;
    webUrl?: string | null;
  }): {
    kind: string;
    host: string;
    port: number;
    label: string | null;
    group: string | null;
    secretRef: string | null;
    webUrl: string | null;
  } {
    const kind = input.kind;
    if (kind !== 'ssh' && kind !== 'rdp' && kind !== 'vnc' && kind !== 'web') {
      throw new BadRequestException('kind must be one of ssh, rdp, vnc, web.');
    }
    const label = input.label?.trim() ? input.label.trim().slice(0, 120) : null;
    const group = input.group?.trim() ? input.group.trim().slice(0, 80) : null;
    const secretRef = input.secretRef?.trim() ? input.secretRef.trim().slice(0, 256) : null;

    // Remote Browser: host/port are parsed from the URL (the remote browser dials them
    // through the tunnel), and the full URL is what the browser opens.
    if (kind === 'web') {
      const raw = (input.webUrl ?? '').trim();
      if (!raw) throw new BadRequestException('A Remote Browser needs a URL.');
      let u: URL;
      try {
        u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
      } catch {
        throw new BadRequestException('Enter a valid URL, e.g. https://10.20.0.5.');
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new BadRequestException('Remote Browser URLs must be http(s).');
      }
      const host = u.hostname;
      if (host === '127.0.0.1' || host.toLowerCase() === 'localhost') {
        throw new BadRequestException('A Waypoint targets the LAN, not its own loopback.');
      }
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      return { kind, host, port, label, group, secretRef: null, webUrl: u.toString() };
    }

    const host = (input.host ?? '').trim();
    if (!host) throw new BadRequestException('host is required.');
    if (host === '127.0.0.1' || host.toLowerCase() === 'localhost') {
      throw new BadRequestException('A Waypoint targets the LAN, not its own loopback.');
    }
    const port = Number(input.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new BadRequestException('port must be 1–65535.');
    }
    return { kind, host, port, label, group, secretRef, webUrl: null };
  }

  async createRoute(
    agentId: string,
    input: RouteInput,
    user: SessionUser,
  ): Promise<FabricAgentDto> {
    await this.requireWaypoint(agentId);
    const t = this.normalizeRoute(input);
    const existing = await this.prisma.agentTarget.findUnique({
      where: { agentId_kind_host_port: { agentId, kind: t.kind, host: t.host, port: t.port } },
      select: { id: true },
    });
    if (existing) throw new BadRequestException('A route for this protocol/host/port already exists.');
    await this.prisma.agentTarget.create({
      data: {
        agentId,
        kind: t.kind,
        host: t.host,
        port: t.port,
        label: t.label,
        group: t.group,
        secretRef: t.secretRef,
        webUrl: t.webUrl,
        source: 'curated',
      },
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.route.created',
      target: agentId,
      meta: { kind: t.kind, host: t.host, port: t.port, label: t.label },
    });
    await this.registry.pushAllow(agentId);
    return this.reloadAgentDto(agentId);
  }

  async updateRoute(
    agentId: string,
    targetId: string,
    input: RouteInput,
    user: SessionUser,
  ): Promise<FabricAgentDto> {
    await this.requireWaypoint(agentId);
    const row = await this.prisma.agentTarget.findFirst({ where: { id: targetId, agentId } });
    if (!row) throw new NotFoundException('Route not found.');
    const t = this.normalizeRoute(input);
    // If host/port/kind changed, re-pin host key from scratch (a different box).
    const identityChanged = row.kind !== t.kind || row.host !== t.host || row.port !== t.port;
    await this.prisma.agentTarget.update({
      where: { id: targetId },
      data: {
        kind: t.kind,
        host: t.host,
        port: t.port,
        label: t.label,
        group: t.group,
        secretRef: t.secretRef,
        webUrl: t.webUrl,
        source: 'curated',
        ...(identityChanged ? { hostKey: null } : {}),
      },
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.route.updated',
      target: agentId,
      meta: { targetId, kind: t.kind, host: t.host, port: t.port },
    });
    await this.registry.pushAllow(agentId);
    return this.reloadAgentDto(agentId);
  }

  async deleteRoute(agentId: string, targetId: string, user: SessionUser): Promise<FabricAgentDto> {
    await this.requireWaypoint(agentId);
    const row = await this.prisma.agentTarget.findFirst({ where: { id: targetId, agentId } });
    if (!row) throw new NotFoundException('Route not found.');
    await this.prisma.agentTarget.delete({ where: { id: targetId } });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.route.deleted',
      target: agentId,
      meta: { targetId, kind: row.kind, host: row.host, port: row.port },
    });
    await this.registry.pushAllow(agentId);
    return this.reloadAgentDto(agentId);
  }

  private async reloadAgentDto(agentId: string): Promise<FabricAgentDto> {
    const agent = await this.prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
      include: { targets: { orderBy: [{ group: 'asc' }, { kind: 'asc' }, { host: 'asc' }, { port: 'asc' }] } },
    });
    return this.toAgentDto(agent, agent.targets);
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
      localIp: agent.localIp,
      notes: agent.notes,
      status: this.registry.statusOf(agent.id, agent.status),
      mode: (agent.mode as FabricAgentDto['mode']) ?? 'endpoint',
      egressCidrs: agent.egressCidrs ?? [],
      requireApproval: !!agent.requireApproval,
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
          source: (t.source as FabricTargetDto['source']) ?? 'discovered',
          group: t.group,
          webUrl: t.webUrl,
        }),
      ),
    };
  }
}
