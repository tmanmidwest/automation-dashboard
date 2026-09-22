import { createHash } from 'crypto';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../logging/audit.service';

/** Who is connecting, for the audit trail + which target's pin to check. */
export interface HostKeyActor {
  userId: string;
  userEmail?: string | null;
  agentId: string;
  /** The curated AgentTarget id; empty for an ad-hoc connection (pinned by
   *  agentId+host+port instead — see below). */
  targetId: string;
  /** Required for ad-hoc pinning (targetId empty). */
  host?: string;
  port?: number;
}

/** Setting key an ad-hoc connection's host key is pinned under (no AgentTarget row). */
function adhocPinKey(agentId: string, host: string, port: number): string {
  return `fabric.adhocHostKey:${agentId}:${host}:${port}`;
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

  // Ad-hoc connections have no AgentTarget row, so pin by agentId+host+port in a
  // Setting row instead of silently accepting any key (which left ad-hoc SSH open
  // to an on-LAN MITM). Curated targets keep pinning against AgentTarget.hostKey.
  const adhoc = !actor.targetId;
  if (adhoc && (!actor.host || !actor.port)) return { ok: true }; // nothing to key on
  const pinKey = adhoc ? adhocPinKey(actor.agentId, actor.host as string, actor.port as number) : null;

  // Read the pinned key. A read FAILURE must not look like "never pinned" — that
  // would take the first-use branch below and re-pin whatever key is presented,
  // silently defeating the MITM check exactly when it matters. Fail closed instead.
  let stored: string | null;
  try {
    if (adhoc) {
      const row = await prisma.setting.findUnique({ where: { key: pinKey as string } });
      stored = typeof row?.value === 'string' ? row.value : null;
    } else {
      const target = await prisma.agentTarget.findUnique({
        where: { id: actor.targetId },
        select: { hostKey: true },
      });
      stored = target?.hostKey ?? null;
    }
  } catch {
    return {
      ok: false,
      reason: 'Could not verify the host key (storage error) — refusing to connect. Try again in a moment.',
    };
  }

  if (!stored) {
    if (adhoc) {
      await prisma.setting
        .upsert({ where: { key: pinKey as string }, update: { value: fp }, create: { key: pinKey as string, value: fp } })
        .catch(() => undefined);
    } else {
      await prisma.agentTarget
        .update({ where: { id: actor.targetId }, data: { hostKey: fp } })
        .catch(() => undefined);
    }
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
