import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type {
  FabricAgentMode,
  FabricApprovalDto,
  FabricApprovalState,
  FabricApprovalStatus,
  FabricSessionTicket,
  FabricVncSessionTicket,
  SessionUser,
} from '@cerebro/shared';
import { AuditService } from '../logging/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

const APPROVAL_TTL_MS = 5 * 60 * 1000; // an unanswered request expires after 5 min

interface PendingApproval {
  id: string;
  agentId: string;
  agentName: string;
  agentMode: FabricAgentMode;
  kind: string;
  target: string;
  requesterId: string;
  requesterEmail?: string | null;
  createdAt: number;
  expiresAt: number;
  state: FabricApprovalState;
  /** Set synchronously when an approver starts minting, so two approvers acting at
   *  once can't both pass the `pending` check and double-provision a session. */
  minting?: boolean;
  decidedByEmail?: string | null;
  mint: () => Promise<FabricSessionTicket>;
  result?: { ticket?: FabricVncSessionTicket; error?: string };
  timer?: NodeJS.Timeout;
}

/**
 * Four-eyes approval for Fabric sessions (see docs/fabric-waypoints.md). When an
 * agent has `requireApproval`, a connect request is held here — as an in-memory
 * record whose `mint` closure keeps the (already-resolved) session so credentials
 * are NEVER persisted — until a `fabric:approve` user approves it, at which point
 * the session is actually minted and handed back to the requester's poll. Records
 * are short-lived and single-instance by design; a restart drops them.
 */
@Injectable()
export class FabricApprovalService {
  private readonly logger = new Logger('FabricApproval');
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Register a held request; notifies approvers and returns its id. */
  async request(
    meta: {
      agentId: string;
      agentName: string;
      agentMode: FabricAgentMode;
      kind: string;
      target: string;
      user: SessionUser;
    },
    mint: () => Promise<FabricSessionTicket>,
  ): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    const p: PendingApproval = {
      id,
      agentId: meta.agentId,
      agentName: meta.agentName,
      agentMode: meta.agentMode,
      kind: meta.kind,
      target: meta.target,
      requesterId: meta.user.id,
      requesterEmail: meta.user.email,
      createdAt: now,
      expiresAt: now + APPROVAL_TTL_MS,
      state: 'pending',
      mint,
    };
    p.timer = setTimeout(() => {
      if (p.state === 'pending') {
        p.state = 'expired';
        p.result = { error: 'Approval request expired.' };
      }
      // Free the record (and its mint closure, which captured the requester's
      // plaintext credentials) shortly after — an un-actioned request must not leak
      // them for the process lifetime. Keep it briefly so the requester's poll can
      // still read "expired".
      this.scheduleCleanup(p);
    }, APPROVAL_TTL_MS);
    p.timer.unref?.();
    this.pending.set(id, p);

    await this.audit.record({
      actorId: meta.user.id,
      actorEmail: meta.user.email,
      action: 'fabric.approval.requested',
      target: meta.agentId,
      meta: { approvalId: id, kind: meta.kind, target: meta.target },
    });
    await this.notifications
      .dispatchAlert('fabric.approval_requested', {
        title: `Approval needed: ${meta.kind.toUpperCase()} via ${meta.agentName}`,
        body: `${meta.user.email ?? 'An operator'} requested a ${meta.kind.toUpperCase()} session to ${meta.target} through ${meta.agentName}. Approve or deny it in Cerebro → Fabric.`,
        dedupeKey: `fabric-approval:${id}`,
      })
      .catch(() => undefined);
    return id;
  }

  /** Pending requests for the approver UI (never exposes the mint/credentials). */
  listPending(): FabricApprovalDto[] {
    const out: FabricApprovalDto[] = [];
    for (const p of this.pending.values()) {
      if (p.state !== 'pending') continue;
      out.push(this.toDto(p));
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** The requester's own poll result (only the requester may read it). */
  status(id: string, user: SessionUser): FabricApprovalStatus {
    const p = this.pending.get(id);
    if (!p) throw new NotFoundException('Approval request not found or expired.');
    if (p.requesterId !== user.id) throw new ForbiddenException('Not your request.');
    return {
      state: p.state,
      ticket: p.state === 'approved' ? p.result?.ticket : undefined,
      error: p.result?.error,
      decidedByEmail: p.decidedByEmail,
    };
  }

  async approve(id: string, user: SessionUser): Promise<FabricApprovalDto> {
    const p = this.pending.get(id);
    if (!p) throw new NotFoundException('Approval request not found or expired.');
    if (p.state !== 'pending') throw new ForbiddenException(`This request is already ${p.state}.`);
    if (p.minting) throw new ForbiddenException('This request is already being approved.');
    if (p.requesterId === user.id) {
      throw new ForbiddenException('You cannot approve your own session request.');
    }
    p.minting = true; // synchronous latch — no await before this point
    p.decidedByEmail = user.email;
    try {
      const ticket = await p.mint();
      p.state = 'approved';
      p.result = { ticket: ticket as FabricVncSessionTicket };
    } catch (e) {
      p.state = 'error';
      p.result = { error: e instanceof Error ? e.message : 'Session failed to start after approval.' };
      this.logger.warn(`Approved session ${id} failed to mint: ${p.result.error}`);
    }
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: p.state === 'approved' ? 'fabric.approval.approved' : 'fabric.approval.mint_failed',
      target: p.agentId,
      meta: { approvalId: id, requester: p.requesterEmail, kind: p.kind, target: p.target },
    });
    this.scheduleCleanup(p);
    return this.toDto(p);
  }

  async deny(id: string, user: SessionUser): Promise<FabricApprovalDto> {
    const p = this.pending.get(id);
    if (!p) throw new NotFoundException('Approval request not found or expired.');
    if (p.state !== 'pending') throw new ForbiddenException(`This request is already ${p.state}.`);
    p.state = 'denied';
    p.decidedByEmail = user.email;
    p.result = { error: `Denied by ${user.email ?? 'an approver'}.` };
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.approval.denied',
      target: p.agentId,
      meta: { approvalId: id, requester: p.requesterEmail, kind: p.kind, target: p.target },
    });
    this.scheduleCleanup(p);
    return this.toDto(p);
  }

  /** Keep a resolved record briefly so the requester's poll can read the outcome. */
  private scheduleCleanup(p: PendingApproval): void {
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => this.pending.delete(p.id), 60_000);
    p.timer.unref?.();
  }

  private toDto(p: PendingApproval): FabricApprovalDto {
    return {
      id: p.id,
      agentId: p.agentId,
      agentName: p.agentName,
      agentMode: p.agentMode,
      kind: p.kind as FabricApprovalDto['kind'],
      target: p.target,
      requesterEmail: p.requesterEmail,
      createdAt: new Date(p.createdAt).toISOString(),
      expiresAt: new Date(p.expiresAt).toISOString(),
      state: p.state,
    };
  }
}
