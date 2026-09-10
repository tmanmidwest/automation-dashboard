import type { ConnectorContext } from '@cerebro/shared';
import type { SshConfig } from '../connectors/docker/docker-ssh';

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** The SSH deploy target derived from a Docker connector instance's context. */
export interface DockerTarget {
  ssh: SshConfig;
  stacksDir: string;
  /** The host containers are published on — also the ingress forward host. */
  hostIp: string;
  /** False when the connector has no SSH configured (deploys need SSH). */
  deployable: boolean;
}

/**
 * Build a Docker SSH deploy target from a decrypted connector context. Mirrors
 * the Docker connector's own `sshTargetFrom` so App Replicator deploys land on
 * the same host, in the same stacks dir, as the connector's own stack deploys.
 */
export function dockerTargetFrom(ctx: ConnectorContext): DockerTarget {
  const host = str(ctx.config.sshHost);
  const key = str(ctx.config.sshPrivateKey);
  const password = str(ctx.config.sshPassword);
  const ssh: SshConfig = {
    host,
    port: Number(ctx.config.sshPort) || 22,
    username: str(ctx.config.sshUser) || 'root',
    privateKey: key,
    password,
  };
  return {
    ssh,
    stacksDir: str(ctx.config.stacksDir) || '/opt/cerebro-stacks',
    hostIp: host,
    deployable: !!host && (!!key || !!password),
  };
}
