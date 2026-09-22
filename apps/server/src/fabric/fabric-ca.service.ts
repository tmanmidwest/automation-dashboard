import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { SessionUser } from '@cerebro/shared';
import { FABRIC_HOST_ALIAS_PREFIX, hasPermission } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../logging/audit.service';
import { fabricConfig } from './fabric-config';

const execFileP = promisify(execFile);

/** Where the CA public key + metadata live (public); the private key is sealed. */
const CA_META_KEY = 'fabric.ca';
const CA_PRIV_SECRET = 'fabric.ca.privateKey';
/** Auto-trust toggle: push CA trust to each agent the first time it comes online. */
const CA_AUTOTRUST_KEY = 'fabric.ca.autoTrust';

/** Path the host-trust snippet installs the CA public key to. */
const HOST_CA_PATH = '/etc/ssh/cerebro_ca.pub';

interface CaMeta {
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

export interface CaStatus {
  enabled: boolean;
  publicKey?: string;
  fingerprint?: string;
  createdAt?: string;
  ttlMinutes: number;
  /** Push CA trust to each agent automatically the first time it comes online. */
  autoTrust: boolean;
  /** Copy-paste one-liners to make a host trust this CA. */
  hostSetupLinux?: string;
  hostSetupWindows?: string;
  /** known_hosts line a client adds once to verify hosts via the CA (host certs). */
  clientTrustLine?: string;
}

/** Host-cert principal must be `cerebro.<slug>` (matches the CLI's HostKeyAlias). */
const HOST_PRINCIPAL_RE = /^cerebro\.[a-z0-9-]{1,64}$/;

/** Privileged login names: a CA cert for one of these grants administrative access
 *  to any box trusting the Cerebro CA, so issuing it needs fabric:manage (not just
 *  the broad fabric:connect). Matched case-insensitively. */
const PRIVILEGED_PRINCIPALS = new Set([
  'root', 'admin', 'administrator', 'sudo', 'wheel', 'toor', 'superuser', 'sysadmin',
]);

/** A username principal on a target box: POSIX-ish, no injection into ssh-keygen args. */
const PRINCIPAL_RE = /^[a-z_][a-z0-9_-]{0,31}$/i;
/** One-line OpenSSH public key. */
const PUBKEY_RE = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/=]+(\s.*)?$/;

/**
 * Cerebro as an SSH certificate authority for Fabric. Generates a CA keypair
 * (private key sealed in the vault), hands out short-lived **user certificates**
 * signed for a requested principal, and prints the host-trust snippet. Boxes that
 * trust the CA (TrustedUserCAKeys) then accept any current cert — no per-box keys.
 * Signing uses the reference `ssh-keygen -s`. See docs/fabric-remote-access.md.
 */
@Injectable()
export class FabricCaService {
  private readonly logger = new Logger(FabricCaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async status(): Promise<CaStatus> {
    const meta = await this.settings.get<CaMeta>(CA_META_KEY);
    const ttlMinutes = fabricConfig.caTtlMinutes;
    const autoTrust = await this.autoTrustEnabled();
    if (!meta?.publicKey) return { enabled: false, ttlMinutes, autoTrust };
    return {
      enabled: true,
      publicKey: meta.publicKey,
      fingerprint: meta.fingerprint,
      createdAt: meta.createdAt,
      ttlMinutes,
      autoTrust,
      hostSetupLinux: hostSetupLinux(meta.publicKey),
      hostSetupWindows: hostSetupWindows(meta.publicKey),
      clientTrustLine: `@cert-authority ${FABRIC_HOST_ALIAS_PREFIX}* ${meta.publicKey}`,
    };
  }

  /** The CA public key, or null when the CA has not been enabled. */
  async publicKey(): Promise<string | null> {
    const meta = await this.settings.get<CaMeta>(CA_META_KEY);
    return meta?.publicKey ?? null;
  }

  /** Whether new agents should be auto-trusted on first connect. */
  async autoTrustEnabled(): Promise<boolean> {
    return (await this.settings.get<boolean>(CA_AUTOTRUST_KEY)) === true;
  }

  async setAutoTrust(enabled: boolean, user: SessionUser): Promise<CaStatus> {
    await this.settings.set(CA_AUTOTRUST_KEY, enabled);
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: enabled ? 'fabric.ca.autotrust_on' : 'fabric.ca.autotrust_off',
    });
    return this.status();
  }

  /** Generate the CA keypair (idempotent — returns the existing one if present). */
  async enable(user: SessionUser): Promise<CaStatus> {
    const existing = await this.settings.get<CaMeta>(CA_META_KEY);
    if (existing?.publicKey) return this.status();

    const dir = await mkdtemp(join(tmpdir(), 'cbroca-'));
    try {
      const keyPath = join(dir, 'ca');
      await execFileP('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'cerebro-fabric-ca', '-q']);
      const priv = await readFile(keyPath, 'utf8');
      const pub = (await readFile(`${keyPath}.pub`, 'utf8')).trim();
      const { stdout } = await execFileP('ssh-keygen', ['-lf', `${keyPath}.pub`]);
      const fingerprint = stdout.trim().split(/\s+/)[1] ?? '';

      await this.settings.setSecret(CA_PRIV_SECRET, priv);
      const meta: CaMeta = { publicKey: pub, fingerprint, createdAt: new Date().toISOString() };
      await this.settings.set(CA_META_KEY, meta);
      await this.audit.record({
        actorId: user.id,
        actorEmail: user.email,
        action: 'fabric.ca.enabled',
        meta: { fingerprint },
      });
      return this.status();
    } catch (e) {
      throw new BadRequestException(`Could not generate the CA key: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Remove the CA keypair. Hosts still trusting it keep the (now-orphan) pubkey
   *  until you remove it there — new certs can no longer be issued. */
  async disable(user: SessionUser): Promise<void> {
    await this.settings.deleteSecret(CA_PRIV_SECRET).catch(() => undefined);
    await this.settings.set(CA_META_KEY, {});
    // Existing host trust is now orphaned — clear the per-agent flags so the
    // green shields reset (a re-enable mints a new key needing fresh trust).
    await this.prisma.agent.updateMany({ data: { caTrustedAt: null } }).catch(() => undefined);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'fabric.ca.disabled' });
  }

  /**
   * Sign an operator's public key into a short-lived user certificate for one
   * principal. The caller must already be allowed to connect (fabric:connect);
   * every issuance is audited.
   */
  async sign(
    publicKey: string,
    principal: string,
    user: SessionUser,
    machineLabel?: string,
  ): Promise<{ certificate: string; ttlMinutes: number; serial: string; principal: string }> {
    const meta = await this.settings.get<CaMeta>(CA_META_KEY);
    if (!meta?.publicKey) throw new BadRequestException('The SSH CA is not enabled.');
    const priv = await this.settings.getSecret(CA_PRIV_SECRET);
    if (!priv) throw new BadRequestException('The CA private key is missing.');

    const pub = (publicKey || '').trim();
    if (!PUBKEY_RE.test(pub)) throw new BadRequestException('That does not look like an OpenSSH public key.');
    if (!PRINCIPAL_RE.test(principal)) throw new BadRequestException('Invalid principal (login username).');
    if (PRIVILEGED_PRINCIPALS.has(principal.toLowerCase()) && !hasPermission(user.permissions, 'fabric:manage')) {
      throw new ForbiddenException(
        `Signing a certificate for the privileged principal "${principal}" requires the fabric:manage permission.`,
      );
    }

    const ttlMinutes = fabricConfig.caTtlMinutes;
    const serial = BigInt(`0x${randomBytes(6).toString('hex')}`).toString();
    const identity = `${(user.email || user.id).replace(/\s+/g, '_')}@cerebro`;

    const dir = await mkdtemp(join(tmpdir(), 'cbrosign-'));
    try {
      const caPath = join(dir, 'ca');
      await writeFile(caPath, priv.endsWith('\n') ? priv : `${priv}\n`, { mode: 0o600 });
      const pubPath = join(dir, 'id.pub');
      await writeFile(pubPath, `${pub}\n`, { mode: 0o644 });

      await execFileP('ssh-keygen', [
        '-s', caPath,
        '-I', identity,
        '-n', principal,
        '-V', `+${ttlMinutes}m`,
        '-z', serial,
        pubPath,
      ]);
      const certificate = (await readFile(join(dir, 'id-cert.pub'), 'utf8')).trim();

      await this.audit.record({
        actorId: user.id,
        actorEmail: user.email,
        action: 'fabric.ca.cert_issued',
        target: machineLabel ?? null,
        meta: { principal, serial, ttlMinutes, identity, machine: machineLabel },
      });
      return { certificate, ttlMinutes, serial, principal };
    } catch (e) {
      throw new BadRequestException(`Signing failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Sign a box's SSH host key into a host certificate for principal
   * `cerebro.<slug>` (matches the CLI's HostKeyAlias), so clients that trust the
   * CA verify the host with no TOFU prompt. Long TTL; renewed on each re-trust.
   */
  async signHostCert(
    hostPublicKey: string,
    principal: string,
    machineLabel: string,
  ): Promise<{ certificate: string }> {
    const meta = await this.settings.get<CaMeta>(CA_META_KEY);
    if (!meta?.publicKey) throw new BadRequestException('The SSH CA is not enabled.');
    const priv = await this.settings.getSecret(CA_PRIV_SECRET);
    if (!priv) throw new BadRequestException('The CA private key is missing.');

    const pub = (hostPublicKey || '').trim();
    if (!PUBKEY_RE.test(pub)) throw new BadRequestException('That does not look like an OpenSSH host key.');
    if (!HOST_PRINCIPAL_RE.test(principal)) throw new BadRequestException('Invalid host principal.');

    const weeks = fabricConfig.caHostTtlWeeks;
    const serial = BigInt(`0x${randomBytes(6).toString('hex')}`).toString();
    const identity = `${(machineLabel || 'host').replace(/\s+/g, '_')}@cerebro`;

    const dir = await mkdtemp(join(tmpdir(), 'cbrohost-'));
    try {
      const caPath = join(dir, 'ca');
      await writeFile(caPath, priv.endsWith('\n') ? priv : `${priv}\n`, { mode: 0o600 });
      const pubPath = join(dir, 'host.pub');
      await writeFile(pubPath, `${pub}\n`, { mode: 0o644 });
      await execFileP('ssh-keygen', [
        '-s', caPath,
        '-h', // host certificate
        '-I', identity,
        '-n', principal,
        '-V', `+${weeks}w`,
        '-z', serial,
        pubPath,
      ]);
      const certificate = (await readFile(join(dir, 'host-cert.pub'), 'utf8')).trim();
      await this.audit.record({
        action: 'fabric.ca.host_cert_issued',
        target: machineLabel,
        meta: { principal, serial, weeks },
      });
      return { certificate };
    } catch (e) {
      throw new BadRequestException(`Host signing failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Bash one-liner: install the CA pubkey + TrustedUserCAKeys, validate, reload sshd. */
function hostSetupLinux(caPub: string): string {
  const line = `TrustedUserCAKeys ${HOST_CA_PATH}`;
  return (
    `sudo sh -c 'umask 022; printf "%s\\n" ${shq(caPub)} > ${HOST_CA_PATH}; ` +
    `grep -qF ${shq(line)} /etc/ssh/sshd_config || printf "%s\\n" ${shq(line)} >> /etc/ssh/sshd_config; ` +
    `sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload 2>/dev/null || true)'`
  );
}

/** PowerShell one-liner for Windows OpenSSH. */
function hostSetupWindows(caPub: string): string {
  const caFile = 'C:\\ProgramData\\ssh\\cerebro_ca.pub';
  const line = 'TrustedUserCAKeys __PROGRAMDATA__\\ssh\\cerebro_ca.pub';
  return (
    `Set-Content -Path '${caFile}' -Value '${caPub.replace(/'/g, "''")}'; ` +
    `$c='C:\\ProgramData\\ssh\\sshd_config'; if(-not(Select-String -SimpleMatch -Quiet -Path $c -Pattern '${line}')){Add-Content $c '${line}'}; ` +
    `Restart-Service sshd`
  );
}

/** Single-quote a value for POSIX sh. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
