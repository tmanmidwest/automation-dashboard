import type { ConnectorContext } from '@cerebro/shared';
import { DockerApi } from '../connectors/docker/docker-api';
import type { SshConfig } from '../connectors/docker/docker-ssh';
import type { DockerStackService } from '../connectors/docker/docker-stack.service';
import type { StackDeployTarget } from '../connectors/docker/docker-stack.service';

/**
 * The two ways stack backup talks to a Docker host: the Engine API (inspect,
 * create volumes) and SSH (run the helper container, write compose). Built from a
 * decrypted connector context so both backup and restore reach a host the same
 * way the Docker connector's own stack deploys do — same user, same stacks dir,
 * same pinned host key. See docs/stack-backup.md.
 */
export interface DockerHostAccess {
  api: DockerApi;
  /** Null when the connector has no SSH configured — backup and restore both need it. */
  ssh: SshConfig | null;
  /** The deploy target DockerStackService takes; null when SSH is unconfigured. */
  target: StackDeployTarget | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

export function hostAccess(ctx: ConnectorContext, stacks: DockerStackService): DockerHostAccess {
  const api = new DockerApi({
    endpoint: str(ctx.config.endpoint),
    tlsCaCert: str(ctx.config.tlsCaCert),
    tlsClientCert: str(ctx.config.tlsClientCert),
    tlsClientKey: str(ctx.config.tlsClientKey),
    insecureSkipVerify: ctx.config.insecureSkipVerify === true,
  });

  const host = str(ctx.config.sshHost);
  const privateKey = str(ctx.config.sshPrivateKey);
  const password = str(ctx.config.sshPassword);
  if (!host || (!privateKey && !password)) return { api, ssh: null, target: null };

  // withHostPin attaches TOFU host-key verification, so no SSH from here skips it.
  const target = stacks.withHostPin({
    ssh: {
      host,
      port: Number(ctx.config.sshPort) || 22,
      username: str(ctx.config.sshUser) || 'root',
      privateKey,
      password,
    },
    stacksDir: str(ctx.config.stacksDir) || '/opt/cerebro-stacks',
  });
  return { api, ssh: target.ssh, target };
}

/** The message shown wherever a host cannot be used because SSH is unconfigured. */
export const NO_SSH_REASON =
  'This host has no SSH configured — backups and restores run a helper container over SSH. Add SSH to the Docker connector.';
