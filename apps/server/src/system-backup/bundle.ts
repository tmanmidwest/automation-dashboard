import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';

/**
 * Passphrase-encrypted container for a full system backup. Layout:
 *   magic "CBROBK" | version(1) | saltLen(1) | salt | ivLen(1) | iv | ciphertext‖GCM-tag
 * The plaintext is gzip(JSON(bundle)). See docs/system-backup.md.
 */

const MAGIC = Buffer.from('CBROBK', 'ascii');
const VERSION = 1;
// scrypt cost — N=2^15 keeps a wrong-passphrase guess expensive without stalling a legit restore.
const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const KEY_LEN = 32;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 256 * 1024 * 1024 });
}

/** Encrypt a JSON-serialisable bundle with a passphrase into the on-disk file format. */
export function sealBundle(bundle: unknown, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const plaintext = gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'));
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    MAGIC,
    Buffer.from([VERSION, salt.length]),
    salt,
    Buffer.from([iv.length]),
    iv,
    ciphertext,
    tag,
  ]);
}

/** Decrypt a backup file. Throws a clear error on a bad magic or wrong passphrase (GCM tag fail). */
export function openBundle<T = unknown>(file: Buffer, passphrase: string): T {
  if (file.length < MAGIC.length + 4 || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Not a Cerebro backup file.');
  }
  let off = MAGIC.length;
  const version = file[off++];
  if (version !== VERSION) throw new Error(`Unsupported backup version ${version}.`);
  const saltLen = file[off++];
  const salt = file.subarray(off, off + saltLen); off += saltLen;
  const ivLen = file[off++];
  const iv = file.subarray(off, off + ivLen); off += ivLen;
  const rest = file.subarray(off);
  if (rest.length < 17) throw new Error('Backup file is truncated.');
  const tag = rest.subarray(rest.length - 16);
  const ciphertext = rest.subarray(0, rest.length - 16);

  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Wrong passphrase, or the backup file is corrupt.');
  }
  return JSON.parse(gunzipSync(plaintext).toString('utf8')) as T;
}
