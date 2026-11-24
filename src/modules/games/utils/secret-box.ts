import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';

const PREFIX = 'v1.';

/** `v1.` + base64url(iv 12 ‖ auth tag 16 ‖ ciphertext), AES-256-GCM. */
export function sealSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return (
    PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')
  );
}

export function openSecret(sealed: string, key: Buffer): string {
  if (!sealed.startsWith(PREFIX)) throw new Error('Unknown secret format');
  const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64url');
  if (raw.length < 28) throw new Error('Secret too short');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([
    decipher.update(raw.subarray(28)),
    decipher.final(),
  ]).toString('utf8');
}

/** Refuses to boot on a missing or malformed key, like requireJwtSecret. */
export function loadSecretKey(config: ConfigService): Buffer {
  const key = Buffer.from(
    config.get<string>('GAMES_SECRET_KEY') ?? '',
    'base64',
  );
  if (key.length !== 32)
    throw new Error('GAMES_SECRET_KEY must be 32 bytes, base64');
  return key;
}
