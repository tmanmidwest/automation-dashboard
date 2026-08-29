import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * AES-256-GCM encryption for the secrets vault.
 *
 * The key is derived from APP_ENCRYPTION_KEY (via SHA-256 → 32 bytes) so any
 * sufficiently random string works, but operators should use
 * `openssl rand -base64 32`. Rotating this key invalidates existing secrets.
 *
 * Ciphertext format (all base64, colon-separated):  iv:authTag:ciphertext
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly key: Buffer;

  constructor() {
    const raw = process.env.APP_ENCRYPTION_KEY;
    if (!raw || raw.length < 16) {
      throw new Error(
        'APP_ENCRYPTION_KEY is missing or too short. Generate one with: openssl rand -base64 32',
      );
    }
    // Derive a stable 32-byte key regardless of the input length.
    this.key = createHash('sha256').update(raw).digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split(':');
    if (!ivB64 || !tagB64 || !dataB64) {
      throw new Error('Malformed ciphertext.');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }
}
