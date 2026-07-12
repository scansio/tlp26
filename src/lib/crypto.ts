/**
 * AES-256-GCM encryption helpers for exchange API key vault.
 *
 * Encryption key is read from EXCHANGE_KEY_ENCRYPTION_SECRET env var (hex, 64 chars = 32 bytes).
 * Each encrypt call generates a fresh 12-byte IV (recommended for GCM).
 * The stored format is: base64(`iv || ciphertext || authTag`) as a single string.
 *
 * Keys are decrypted only at trade execution time and must not be cached beyond
 * the request/operation lifecycle.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit IV — NIST recommended for GCM
const TAG_BYTES = 16; // 128-bit auth tag

function getEncryptionKey(): Buffer {
  const secret = process.env.EXCHANGE_KEY_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error('EXCHANGE_KEY_ENCRYPTION_SECRET environment variable is not set');
  }
  // Accept either a 64-char hex string (32 bytes) or any string we SHA-256 to 32 bytes
  if (/^[0-9a-f]{64}$/i.test(secret)) {
    return Buffer.from(secret, 'hex');
  }
  // Fallback: derive 32-byte key from the secret via SHA-256
  return createHash('sha256').update(secret).digest();
}

/**
 * Encrypts a plaintext string.
 * @returns base64-encoded `iv || ciphertext || authTag`
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: iv (12) + ciphertext (variable) + authTag (16)
  const packed = Buffer.concat([iv, encrypted, authTag]);
  return packed.toString('base64');
}

/**
 * Decrypts a value produced by `encrypt()`.
 * @param stored base64-encoded `iv || ciphertext || authTag`
 * @returns original plaintext
 */
export function decrypt(stored: string): string {
  const key = getEncryptionKey();
  const packed = Buffer.from(stored, 'base64');

  if (packed.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Invalid encrypted payload: too short');
  }

  const iv = packed.subarray(0, IV_BYTES);
  const authTag = packed.subarray(packed.length - TAG_BYTES);
  const ciphertext = packed.subarray(IV_BYTES, packed.length - TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
