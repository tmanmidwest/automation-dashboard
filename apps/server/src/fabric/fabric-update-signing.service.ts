import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, createPrivateKey, generateKeyPairSync, sign as edSign, type KeyObject } from 'crypto';
import { readFile } from 'fs/promises';
import type { SessionUser } from '@cerebro/shared';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../logging/audit.service';

/** Public metadata (safe to expose); the private key is sealed in the vault. */
const META_KEY = 'fabric.updateSigning';
const PRIV_SECRET = 'fabric.updateSigning.privateKey';
/** Offline mode: operator-uploaded signatures, keyed by binary sha256 (hex). */
const OFFLINE_SIGS_KEY = 'fabric.updateSigning.offlineSigs';

interface SigningMeta {
  /** 'vault' — Cerebro holds the key and signs automatically; 'offline' — only the
   *  public key is here, signatures are uploaded by the operator. */
  mode: 'vault' | 'offline';
  /** base64 raw 32-byte ed25519 public key (what agents pin + verify against). */
  publicKey: string;
  fingerprint: string; // "SHA256:…" over the raw public key
  createdAt: string;
}

export interface SigningStatus {
  enabled: boolean;
  mode?: 'vault' | 'offline';
  publicKey?: string;
  fingerprint?: string;
  createdAt?: string;
}

/** SPKI DER for an ed25519 public key is a fixed 12-byte prefix + the raw 32 bytes. */
function rawEd25519Public(pub: KeyObject): Buffer {
  const spki = pub.export({ type: 'spki', format: 'der' });
  return Buffer.from(spki.subarray(spki.length - 32));
}

function fingerprintOf(rawPub: Buffer): string {
  return `SHA256:${createHash('sha256').update(rawPub).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Signs Cerebro agent update binaries so an agent only applies an update whose
 * signature verifies against a public key it pinned at enrollment — closing the
 * "a compromised broker / MITM pushes a malicious binary that every agent runs as
 * root" vector. Vault mode (dummy-proof) generates + holds the key and signs on
 * the fly; offline mode holds only the public key and serves operator-uploaded
 * signatures (so the private key never touches the running server). See
 * docs/fabric-agent-signing.md.
 */
@Injectable()
export class FabricUpdateSigningService {
  private readonly logger = new Logger(FabricUpdateSigningService.name);
  /** Cache signatures by binary sha256 (hex) so we don't re-sign each request. */
  private readonly sigCache = new Map<string, string>();

  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async status(): Promise<SigningStatus> {
    const meta = await this.settings.get<SigningMeta>(META_KEY);
    if (!meta?.publicKey) return { enabled: false };
    return {
      enabled: true,
      mode: meta.mode,
      publicKey: meta.publicKey,
      fingerprint: meta.fingerprint,
      createdAt: meta.createdAt,
    };
  }

  /** The pinned public key agents verify against (base64 raw), or null when unset. */
  async publicKeyForAck(): Promise<string | null> {
    const meta = await this.settings.get<SigningMeta>(META_KEY);
    return meta?.publicKey ?? null;
  }

  /**
   * Generate the signing keypair (vault mode): private key sealed in the vault,
   * public key + fingerprint stored as meta. Refuses to clobber an existing key
   * unless `regenerate` is set (rotation — see the runbook: pinned agents keep the
   * OLD key, so a rotate needs them to re-pin via re-enrollment).
   */
  async generate(user: SessionUser, regenerate = false): Promise<SigningStatus> {
    const existing = await this.settings.get<SigningMeta>(META_KEY);
    if (existing?.publicKey && !regenerate) return this.status();

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPub = rawEd25519Public(publicKey);
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const meta: SigningMeta = {
      mode: 'vault',
      publicKey: rawPub.toString('base64'),
      fingerprint: fingerprintOf(rawPub),
      createdAt: new Date().toISOString(),
    };
    await this.settings.setSecret(PRIV_SECRET, pkcs8);
    await this.settings.set(META_KEY, meta);
    this.sigCache.clear();
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: regenerate ? 'fabric.update_signing.rotated' : 'fabric.update_signing.enabled',
      meta: { fingerprint: meta.fingerprint },
    });
    return this.status();
  }

  /**
   * Offline mode (offline-ready path): import an externally-generated public key
   * (base64 raw ed25519). The private key never comes here; the operator signs
   * releases offline and uploads signatures via {@link storeOfflineSignature}.
   */
  async importPublicKey(publicKeyBase64: string, user: SessionUser): Promise<SigningStatus> {
    const raw = Buffer.from((publicKeyBase64 || '').trim(), 'base64');
    if (raw.length !== 32) throw new BadRequestException('An ed25519 public key must be 32 raw bytes (base64).');
    const meta: SigningMeta = {
      mode: 'offline',
      publicKey: raw.toString('base64'),
      fingerprint: fingerprintOf(raw),
      createdAt: new Date().toISOString(),
    };
    await this.settings.deleteSecret(PRIV_SECRET).catch(() => undefined); // no private key on the server in offline mode
    await this.settings.set(META_KEY, meta);
    this.sigCache.clear();
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.update_signing.offline_imported',
      meta: { fingerprint: meta.fingerprint },
    });
    return this.status();
  }

  /** Store an operator-uploaded signature (offline mode) for a binary sha256. */
  async storeOfflineSignature(sha256Hex: string, signatureBase64: string, user: SessionUser): Promise<void> {
    if (!/^[0-9a-f]{64}$/i.test(sha256Hex)) throw new BadRequestException('Invalid binary hash.');
    if (Buffer.from((signatureBase64 || '').trim(), 'base64').length !== 64) {
      throw new BadRequestException('An ed25519 signature must be 64 raw bytes (base64).');
    }
    const map = (await this.settings.get<Record<string, string>>(OFFLINE_SIGS_KEY)) ?? {};
    map[sha256Hex.toLowerCase()] = signatureBase64.trim();
    await this.settings.set(OFFLINE_SIGS_KEY, map);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'fabric.update_signing.offline_sig_uploaded', meta: { sha256: sha256Hex } });
  }

  /**
   * The detached signature (base64) over a binary file's sha256, or null when
   * signing isn't set up (or, in offline mode, no signature was uploaded for this
   * exact binary). Verified by the agent against its pinned public key.
   */
  async signatureForBinary(filePath: string): Promise<string | null> {
    const meta = await this.settings.get<SigningMeta>(META_KEY);
    if (!meta?.publicKey) return null;
    const digest = createHash('sha256').update(await readFile(filePath)).digest();
    const hex = digest.toString('hex');
    const cached = this.sigCache.get(hex);
    if (cached) return cached;

    if (meta.mode === 'offline') {
      const map = (await this.settings.get<Record<string, string>>(OFFLINE_SIGS_KEY)) ?? {};
      const sig = map[hex] ?? null;
      if (sig) this.sigCache.set(hex, sig);
      return sig;
    }

    // Vault mode: sign the digest with the sealed private key.
    const pem = await this.settings.getSecret(PRIV_SECRET);
    if (!pem) {
      this.logger.warn('Update signing is enabled (vault) but the private key is missing.');
      return null;
    }
    const key = createPrivateKey(pem);
    const sig = edSign(null, digest, key).toString('base64');
    this.sigCache.set(hex, sig);
    return sig;
  }
}
