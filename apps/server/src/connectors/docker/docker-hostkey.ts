import type { PrismaService } from '../../prisma/prisma.service';

/**
 * TOFU SSH host-key pinning for Docker deploy hosts. Learns + pins the host key on
 * first connect, accepts an exact match, and refuses a changed key (possible MITM,
 * or the host was rebuilt) — the same model the Fabric SSH path uses. The pin lives
 * in a `Setting` row keyed by host:port so it is shared across reconnects and every
 * connector instance targeting the same host.
 *
 * Fails CLOSED on a storage read error (a DB blip must not look like "never pinned"
 * and silently re-pin whatever key is presented — the same fix applied to Fabric).
 * A legitimately rebuilt host is re-trusted by deleting its pin row.
 */
export function dockerHostVerifier(
  prisma: PrismaService,
  host: string,
  port: number,
  log?: { pinned?: (msg: string) => void; mismatch?: (msg: string) => void },
): (fingerprint: string) => Promise<boolean> {
  const key = `docker.sshHostKey:${host}:${port}`;
  return async (fp: string): Promise<boolean> => {
    let stored: string | null;
    try {
      const row = await prisma.setting.findUnique({ where: { key } });
      stored = typeof row?.value === 'string' ? row.value : null;
    } catch {
      log?.mismatch?.(`Could not read the pinned SSH host key for ${host}:${port} — refusing to connect.`);
      return false; // fail closed
    }
    if (!stored) {
      await prisma.setting
        .upsert({ where: { key }, update: { value: fp }, create: { key, value: fp } })
        .catch(() => undefined);
      log?.pinned?.(`Pinned SSH host key for ${host}:${port} on first connect.`);
      return true;
    }
    if (stored === fp) return true;
    log?.mismatch?.(`SSH host key mismatch for ${host}:${port} — refusing (possible MITM or a rebuilt host; clear the pin to re-trust).`);
    return false;
  };
}

/** The Setting key a Docker host's pinned SSH key lives under (for clearing it). */
export function dockerHostKeyPinKey(host: string, port: number): string {
  return `docker.sshHostKey:${host}:${port}`;
}
