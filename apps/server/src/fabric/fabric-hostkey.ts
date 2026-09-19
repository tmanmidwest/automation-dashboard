import { createHash } from 'crypto';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../logging/audit.service';

/** Who is connecting, for the audit trail + which target's pin to check. */
export interface HostKeyActor {
  userId: string;
  userEmail?: string | null;
  agentId: string;
  targetId: string;
}

/**
 * Trust-on-first-use SSH host-key check, shared by the in-browser terminal and
 * the SFTP file browser so both pin against the SAME AgentTarget.hostKey. Learns
 * the fingerprint on first connect (accepts + pins), accepts an exact match, and
 * refuses a changed key (possible MITM, or the host was rebuilt). Audits each
 * outcome. A rebuilt host needs its pinned key cleared in Cerebro.
 */
export async function checkHostKey(
  prisma: PrismaService,
  audit: AuditService,
  actor: HostKeyActor,
  key: Buffer,
): Promise<{ ok: boolean; reason?: string }> {
  const fp = createHash('sha256').update(key).digest('base64');
  const target = await prisma.agentTarget
    .findUnique({ where: { id: actor.targetId }, select: { hostKey: true } })
    .catch(() => null);
  const stored = target?.hostKey ?? null;

  if (!stored) {
    await prisma.agentTarget
      .update({ where: { id: actor.targetId }, data: { hostKey: fp } })
      .catch(() => undefined);
    await audit.record({
      actorId: actor.userId,
      actorEmail: actor.userEmail,
      action: 'fabric.hostkey.pinned',
      target: actor.agentId,
      meta: { targetId: actor.targetId, fingerprint: fp },
    });
    return { ok: true };
  }
  if (stored === fp) return { ok: true };

  await audit.record({
    actorId: actor.userId,
    actorEmail: actor.userEmail,
    action: 'fabric.hostkey.mismatch',
    target: actor.agentId,
    meta: { targetId: actor.targetId, expected: stored, got: fp },
  });
  return {
    ok: false,
    reason:
      'Host key mismatch — refusing to connect (possible MITM, or the host was rebuilt). ' +
      'If the host is legitimately new, reset its pinned key in Cerebro and reconnect.',
  };
}
