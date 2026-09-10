import { Injectable } from '@nestjs/common';
import { runSsh, type SshConfig } from '../connectors/docker/docker-ssh';

/**
 * Discovers which host ports are already published on a Docker host and suggests
 * free ones, so a deployment never collides with a running container. Read-only.
 * See docs/app-replicator.md.
 */
@Injectable()
export class PortAllocatorService {
  /** Published host ports currently in use on the target (docker + listening sockets). */
  async usedPorts(ssh: SshConfig): Promise<number[]> {
    const ports = new Set<number>();

    // Docker-published ports: "0.0.0.0:8000->8000/tcp, :::8000->8000/tcp".
    const ps = await runSsh(ssh, `docker ps --format '{{.Ports}}'`).catch(() => null);
    if (ps?.stdout) {
      for (const m of ps.stdout.matchAll(/(\d+)->\d+\/(?:tcp|udp)/g)) ports.add(Number(m[1]));
    }

    // Also any host listening socket (catches non-docker services). Best-effort.
    const ss = await runSsh(ssh, `ss -H -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true`).catch(() => null);
    if (ss?.stdout) {
      for (const m of ss.stdout.matchAll(/[:.](\d+)\s+(?:[0-9.:*\[\]]+\s+)*LISTEN|:(\d+)\s/g)) {
        const p = Number(m[1] ?? m[2]);
        if (Number.isFinite(p) && p > 0) ports.add(p);
      }
    }

    return [...ports].sort((a, b) => a - b);
  }

  /**
   * Suggest a free host port for a container port. Prefers the container port
   * itself (so 8000→8000 when possible); otherwise the next free port at/above a
   * sane floor. `taken` accumulates ports already assigned within the same deploy.
   */
  suggest(containerPort: number, used: Set<number>, taken: Set<number>): number {
    const floor = containerPort >= 1024 ? containerPort : 8000;
    let p = floor;
    while (used.has(p) || taken.has(p)) p++;
    taken.add(p);
    return p;
  }
}
