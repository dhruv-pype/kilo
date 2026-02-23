/**
 * Credential Vault — AES-256-GCM encryption for tool API credentials.
 *
 * Uses native Node.js crypto (no external dependencies).
 * Key is sourced from KILO_CREDENTIAL_KEY environment variable (32 bytes, hex-encoded).
 * Each encryption uses a random 12-byte IV — never reuses IVs.
 * GCM auth tag detects tampering.
 *
 * SECURITY: Plaintext credentials are NEVER logged, stored in prompts, or returned in API responses.
 */

import crypto from 'node:crypto';
import { CredentialError } from '../common/errors/index.js';
import type { EncryptedPayload } from '../common/types/tool-registry.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;        // 96-bit IV for GCM (NIST recommended)
const AUTH_TAG_LENGTH = 16;  // 128-bit auth tag

function getKey(): Buffer {
  const keyHex = process.env.KILO_CREDENTIAL_KEY;
  if (!keyHex) {
    throw new CredentialError('KILO_CREDENTIAL_KEY environment variable is not set');
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new CredentialError('KILO_CREDENTIAL_KEY must be a 64-character hex string (32 bytes)');
  }
  return key;
}

export function encryptCredential(plaintext: string): EncryptedPayload {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext,
  };
}

export function decryptCredential(encrypted: EncryptedPayload): string {
  const key = getKey();
  const iv = Buffer.from(encrypted.iv, 'hex');
  const authTag = Buffer.from(encrypted.authTag, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let plaintext = decipher.update(encrypted.ciphertext, 'hex', 'utf8');
  try {
    plaintext += decipher.final('utf8');
  } catch (err) {
    throw new CredentialError('Credential decryption failed: data may be tampered', err);
  }

  return plaintext;
}
