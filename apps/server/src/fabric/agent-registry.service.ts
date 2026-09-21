import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { WebSocket } from 'ws';
import {
  FABRIC_AGENT_VERSION,
  type FabricAgentStatus,
  type FabricControlFrame,
  type FabricHelloFrame,
} from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { fabricHostAlias } from '@cerebro/shared';
import { parseCredential, safeEqualHex, sha256 } from './fabric-credentials';
import { StreamMux, type TunnelStream } from './stream-mux';
import { fabricConfig } from './fabric-config';
import { FabricCaService } from './fabric-ca.service';

interface LiveAgent {
  ws: WebSocket;
  lastBeat: number;
  offlineTimer: NodeJS.Timeout;
  mux: StreamMux;
}

/**
 * Tracks the live, connected Fabric agents (in memory) and reconciles their
 * liveness into the Agent table. One process is the rendezvous point for all
 * agents; a missed-heartbeat window flips an agent offline. Phase 1 carries no
 * data streams — this only handles identity + liveness.
 */
@Injectable()
export class AgentRegistryService {
  private readonly logger = new Logger(AgentRegistryService.name);
  private readonly live = new Map<string, LiveAgent>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly ca: FabricCaService,
  ) {}

  /**
   * Reconcile the DB against the live registry once a minute. Catches agents that
   * are marked 'online' in the DB but hold no live connection and haven't been
   * seen for a while — e.g. an agent that died while this process was restarting,
   * so no in-memory offline transition ever fired. Marks them offline (which also
   * raises the offline alert), reusing the normal path. The lastSeen grace avoids
   * false positives while an agent is mid-reconnect right after a restart.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileOffline(): Promise<void> {
    const staleBefore = new Date(Date.now() - fabricConfig.reconcileGraceMs);
    let rows: { id: string; lastSeenAt: Date | null }[];
    try {
      rows = await this.prisma.agent.findMany({
        where: { status: 'online' },
        select: { id: true, lastSeenAt: true },
      });
    } catch {
      return;
    }
    for (const a of rows) {
      if (this.isOnline(a.id)) continue; // holds a live connection — fine
      if (a.lastSeenAt && a.lastSeenAt > staleBefore) continue; // may be reconnecting; wait
      await this.markOffline(a.id, 'no heartbeat (reconciled)');
    }
  }

  /** Verify a presented agent credential; returns the agent id or null. */
  async authenticate(credential: string): Promise<string | null> {
    const parsed = parseCredential(credential);
    if (!parsed) return null;
    const agent = await this.prisma.agent.findUnique({ where: { credPrefix: parsed.prefix } });
    if (!agent || !agent.credHash || agent.status === 'revoked') return null;
    if (!safeEqualHex(sha256(parsed.secret), agent.credHash)) return null;
    return agent.id;
  }

  /** True while the agent holds a live control connection. */
  isOnline(agentId: string): boolean {
    return this.live.has(agentId);
  }

  /**
   * The effective status to show: the live connection wins for connected agents;
   * otherwise the stored status carries pending/revoked, and everything else that
   * has ever connected reads as offline.
   */
  statusOf(agentId: string, stored: string): FabricAgentStatus {
    if (this.isOnline(agentId)) return 'online';
    if (stored === 'pending' || stored === 'revoked') return stored;
    return 'offline';
  }

  /**
   * Attach a freshly-authenticated agent socket. Waits for the `hello` frame to
   * mark it online (so a socket that connects but never identifies never flips
   * the agent green). Wires close/error to teardown.
   */
  register(agentId: string, ws: WebSocket): void {
    // Replace any stale connection for the same agent.
    this.live.get(agentId)?.ws.close(4000, 'superseded');

    const entry: LiveAgent = {
      ws,
      lastBeat: Date.now(),
      offlineTimer: this.armOfflineTimer(agentId),
      mux: new StreamMux(
        (frame) => {
          try {
            ws.send(JSON.stringify(frame));
          } catch {
            /* socket gone */
          }
        },
        (buf) => {
          try {
            ws.send(buf, { binary: true });
          } catch {
            /* socket gone */
          }
        },
        this.logger,
      ),
    };
    this.live.set(agentId, entry);

    ws.on('close', () => this.handleClose(agentId, ws));
    ws.on('error', () => this.handleClose(agentId, ws));
    this.logger.log(`Agent ${agentId} connected.`);
  }

  /**
   * Open a tunnelled TCP stream to a target on the agent. Resolves once the
   * agent reports the local dial succeeded. Throws if the agent is offline or
   * the dial fails/times out.
   */
  openStream(agentId: string, host: string, port: number): Promise<TunnelStream> {
    const entry = this.live.get(agentId);
    if (!entry) return Promise.reject(new Error('Agent is not connected.'));
    return entry.mux.openStream(host, port);
  }

  /** Route an inbound BINARY tunnel-data frame (streamId prefix + payload). */
  handleAgentData(agentId: string, data: Buffer): void {
    const entry = this.live.get(agentId);
    if (!entry || data.length < 4) return;
    const streamId = data.readUInt32BE(0);
    entry.mux.handleData(streamId, data.subarray(4));
  }

  /** Route one decoded control frame from an agent. */
  async handleFrame(agentId: string, frame: FabricControlFrame): Promise<void> {
    switch (frame.t) {
      case 'hello':
        await this.onHello(agentId, frame);
        break;
      case 'heartbeat':
        this.onHeartbeat(agentId);
        break;
      case 'targets':
        // The agent re-probed its ports and the reachable set changed — reconcile
        // the same way as hello, so a newly-enabled service appears live.
        await this.syncTargets(agentId, frame.targets ?? []);
        break;
      case 'ca-result':
        if (frame.ok) {
          await this.prisma.agent
            .update({ where: { id: agentId }, data: { caTrustedAt: new Date() } })
            .catch(() => undefined);
        }
        await this.audit.record({
          action: frame.ok ? 'fabric.ca.host_trusted' : 'fabric.ca.host_trust_failed',
          target: agentId,
          meta: frame.ok ? {} : { error: frame.error },
        });
        break;
      case 'host-key':
        await this.signHostCertFor(agentId, frame.publicKey, frame.keyType);
        break;
      case 'stream-opened':
      case 'stream-error':
      case 'close-stream':
        this.live.get(agentId)?.mux.handleControl(frame);
        break;
      default:
        // Broker-only frame types are ignored if an agent ever sends them.
        break;
    }
  }

  private async onHello(agentId: string, frame: FabricHelloFrame): Promise<void> {
    const entry = this.live.get(agentId);
    if (!entry) return;
    entry.lastBeat = Date.now();

    const before = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!before || before.status === 'revoked') {
      entry.ws.close(4003, 'revoked');
      return;
    }

    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        status: 'online',
        os: frame.os ?? before.os,
        osVersion: frame.osVersion ?? before.osVersion,
        hostname: frame.hostname ?? before.hostname,
        agentVersion: frame.agentVersion ?? before.agentVersion,
        localIp: frame.localIp ?? before.localIp,
        lastSeenAt: new Date(),
      },
    });

    // A Waypoint self-discovers nothing — its targets are operator-curated, so we
    // never let its self-report touch the allow-list. An endpoint agent reconciles
    // its discovered loopback services as before.
    if (before.mode !== 'waypoint') {
      await this.syncTargets(agentId, frame.targets ?? []);
    }

    if (before.status !== 'online') {
      await this.audit.record({
        action: 'fabric.agent.online',
        target: agentId,
        meta: { name: before.name, hostname: frame.hostname, os: frame.os, agentVersion: frame.agentVersion },
      });
      // Recovery alert only when it was actually offline (not first enrollment).
      if (before.status === 'offline') {
        await this.notifications
          .dispatchAlert('fabric.agent_online', {
            title: `Fabric agent back online: ${before.name}`,
            body: `${before.name}${frame.hostname ? ` (${frame.hostname})` : ''} reconnected to Cerebro.`,
            dedupeKey: `fabric-online:${agentId}`,
          })
          .catch(() => undefined);
      }
    }

    // A Waypoint learns its reachable set from the broker: send the curated
    // allow-list with the ack so it can serve sessions immediately on connect.
    const allow = before.mode === 'waypoint' ? await this.computeAllow(agentId) : undefined;
    this.send(agentId, {
      t: 'hello-ack',
      agentId,
      heartbeatMs: fabricConfig.heartbeatMs,
      latestAgentVersion: FABRIC_AGENT_VERSION,
      ...(allow ? { allow, egressCidrs: before.egressCidrs ?? [] } : {}),
    });

    // Auto-trust: push CA trust to an untrusted agent (once it succeeds, the
    // caTrustedAt flag stops this from firing again).
    if (!before.caTrustedAt) void this.maybeAutoTrustCa(agentId);
  }

  /** The set of LAN host:port a Waypoint is permitted to dial (its routes). */
  private async computeAllow(agentId: string): Promise<Array<{ host: string; port: number }>> {
    const rows = await this.prisma.agentTarget.findMany({
      where: { agentId },
      select: { host: true, port: true },
    });
    // De-dupe (a host may host several protocols on distinct ports).
    const seen = new Set<string>();
    const out: Array<{ host: string; port: number }> = [];
    for (const r of rows) {
      const key = `${r.host}:${r.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ host: r.host, port: r.port });
    }
    return out;
  }

  /**
   * Push a Waypoint's current allow-list to it live (after an operator adds/edits/
   * removes a route), so its reachable set updates without a reconnect.
   * Best-effort: only reaches an online agent. Returns whether it was delivered.
   */
  async pushAllow(agentId: string): Promise<boolean> {
    if (!this.live.has(agentId)) return false;
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { egressCidrs: true },
    });
    const allow = await this.computeAllow(agentId);
    this.send(agentId, { t: 'set-allow', allow, egressCidrs: agent?.egressCidrs ?? [] });
    return true;
  }

  /** If auto-trust is on and the CA is enabled, push CA trust to this agent. */
  private async maybeAutoTrustCa(agentId: string): Promise<void> {
    try {
      if (!(await this.ca.autoTrustEnabled())) return;
      const pub = await this.ca.publicKey();
      if (!pub) return;
      if (this.requestInstallCa(agentId, pub)) {
        await this.audit.record({ action: 'fabric.ca.autotrust_pushed', target: agentId });
      }
    } catch {
      /* best-effort */
    }
  }

  private onHeartbeat(agentId: string): void {
    const entry = this.live.get(agentId);
    if (!entry) return;
    entry.lastBeat = Date.now();
    clearTimeout(entry.offlineTimer);
    entry.offlineTimer = this.armOfflineTimer(agentId);
    // Best-effort liveness stamp; fire-and-forget at homelab cardinality.
    this.prisma.agent
      .update({ where: { id: agentId }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  /** Reconcile the agent's declared local targets into AgentTarget rows. */
  private async syncTargets(
    agentId: string,
    targets: FabricHelloFrame['targets'],
  ): Promise<void> {
    // Never let a Waypoint's (unexpected) self-report inject allow-list rows — its
    // targets are operator-curated only.
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { mode: true },
    });
    if (agent?.mode === 'waypoint') return;
    for (const t of targets) {
      if (t.kind !== 'ssh' && t.kind !== 'rdp' && t.kind !== 'vnc') continue;
      const host = t.host || '127.0.0.1';
      const port = Number(t.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
      await this.prisma.agentTarget
        .upsert({
          where: { agentId_kind_host_port: { agentId, kind: t.kind, host, port } },
          update: { label: t.label ?? undefined },
          create: { agentId, kind: t.kind, host, port, label: t.label ?? null },
        })
        .catch(() => undefined);
    }
  }

  /**
   * Ask a currently-connected agent to uninstall itself (stop its service and
   * remove its files), then drop the connection shortly after so the frame
   * flushes. Best-effort: only reaches an online agent. Returns whether the
   * agent was online to receive it.
   */
  requestUninstall(agentId: string): boolean {
    const entry = this.live.get(agentId);
    if (!entry) return false;
    try {
      entry.ws.send(JSON.stringify({ t: 'uninstall' }));
    } catch {
      /* socket gone */
    }
    setTimeout(() => this.disconnect(agentId, 4003, 'uninstalled'), 3000);
    return true;
  }

  /** Push an SSH CA public key to an online agent to install into sshd trust.
   *  Returns whether the agent was online to receive it. */
  requestInstallCa(agentId: string, caPublicKey: string): boolean {
    const entry = this.live.get(agentId);
    if (!entry) return false;
    this.send(agentId, { t: 'install-ca', caPublicKey });
    return true;
  }

  /** Sign an agent's offered host key into a host cert and send it back. The
   *  principal is `cerebro.<slug(name)>` — the same alias the CLI verifies against. */
  private async signHostCertFor(agentId: string, publicKey: string, keyType: string): Promise<void> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId }, select: { name: true } });
    if (!agent) return;
    try {
      const { certificate } = await this.ca.signHostCert(publicKey, fabricHostAlias(agent.name), agent.name);
      this.send(agentId, { t: 'host-cert', certificate, keyType });
    } catch (e) {
      await this.audit.record({
        action: 'fabric.ca.host_cert_failed',
        target: agentId,
        meta: { error: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  /** Force-disconnect an agent (used on revoke/delete). */
  disconnect(agentId: string, code = 4003, reason = 'revoked'): void {
    const entry = this.live.get(agentId);
    if (!entry) return;
    clearTimeout(entry.offlineTimer);
    this.live.delete(agentId);
    entry.mux.dispose();
    try {
      entry.ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  private send(agentId: string, frame: FabricControlFrame): void {
    const entry = this.live.get(agentId);
    if (!entry) return;
    try {
      entry.ws.send(JSON.stringify(frame));
    } catch {
      /* socket gone; close handler will clean up */
    }
  }

  private armOfflineTimer(agentId: string): NodeJS.Timeout {
    const timer = setTimeout(
      () => void this.markOffline(agentId, 'missed heartbeats'),
      fabricConfig.heartbeatMs * (fabricConfig.missedBeatsOffline + 1),
    );
    // Don't keep the event loop alive solely for this timer.
    timer.unref?.();
    return timer;
  }

  private handleClose(agentId: string, ws: WebSocket): void {
    const entry = this.live.get(agentId);
    if (!entry || entry.ws !== ws) return; // already superseded
    void this.markOffline(agentId, 'connection closed');
  }

  private async markOffline(agentId: string, reason: string): Promise<void> {
    const entry = this.live.get(agentId);
    if (entry) {
      clearTimeout(entry.offlineTimer);
      this.live.delete(agentId);
      entry.mux.dispose();
      try {
        entry.ws.close();
      } catch {
        /* noop */
      }
    }
    this.logger.log(`Agent ${agentId} offline (${reason}).`);
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } }).catch(() => null);
    if (!agent || agent.status === 'revoked' || agent.status === 'offline') return;
    await this.prisma.agent
      .update({ where: { id: agentId }, data: { status: 'offline' } })
      .catch(() => undefined);
    await this.audit.record({
      action: 'fabric.agent.offline',
      target: agentId,
      meta: { name: agent.name, reason },
    });
    await this.notifications
      .dispatchAlert('fabric.agent_offline', {
        title: `Fabric agent offline: ${agent.name}`,
        body: `${agent.name}${agent.hostname ? ` (${agent.hostname})` : ''} stopped checking in (${reason}).`,
        dedupeKey: `fabric-offline:${agentId}`,
      })
      .catch(() => undefined);
  }
}
