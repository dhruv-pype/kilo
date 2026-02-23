import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encryptCredential, decryptCredential } from '@/tool-execution/credential-vault.js';
import { CredentialError } from '@common/errors/index.js';

// A valid 32-byte key (64 hex chars)
const TEST_KEY = 'afc6f022e5554996a26ee6d796a583fed48a953e38671d4463acd0a6563494cf';

describe('credential-vault', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.KILO_CREDENTIAL_KEY;
    process.env.KILO_CREDENTIAL_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.KILO_CREDENTIAL_KEY;
    } else {
      process.env.KILO_CREDENTIAL_KEY = originalKey;
    }
  });

  it('encrypts and decrypts a simple string', () => {
    const plaintext = '{"token":"sk-1234"}';
    const encrypted = encryptCredential(plaintext);
    const decrypted = decryptCredential(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts complex JSON credentials', () => {
    const plaintext = JSON.stringify({
      clientId: 'abc',
      clientSecret: 'def-ghi-jkl',
      tokenUrl: 'https://auth.example.com/token',
      accessToken: 'eyJhbGciOiJSUzI1NiJ9.xxx',
    });
    const encrypted = encryptCredential(plaintext);
    const decrypted = decryptCredential(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('produces hex-encoded fields in encrypted payload', () => {
    const encrypted = encryptCredential('test');
    expect(encrypted.iv).toMatch(/^[0-9a-f]+$/);
    expect(encrypted.authTag).toMatch(/^[0-9a-f]+$/);
    expect(encrypted.ciphertext).toMatch(/^[0-9a-f]+$/);
  });

  it('generates a 12-byte IV (24 hex chars)', () => {
    const encrypted = encryptCredential('test');
    expect(encrypted.iv.length).toBe(24); // 12 bytes * 2 hex chars
  });

  it('generates a 16-byte auth tag (32 hex chars)', () => {
    const encrypted = encryptCredential('test');
    expect(encrypted.authTag.length).toBe(32); // 16 bytes * 2 hex chars
  });

  it('uses a unique IV for each encryption', () => {
    const e1 = encryptCredential('same data');
    const e2 = encryptCredential('same data');
    expect(e1.iv).not.toBe(e2.iv);
    // Ciphertext should also differ due to random IV
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
  });

  it('throws CredentialError when env key is missing', () => {
    delete process.env.KILO_CREDENTIAL_KEY;
    expect(() => encryptCredential('test')).toThrow(CredentialError);
  });

  it('throws CredentialError when env key is wrong length', () => {
    process.env.KILO_CREDENTIAL_KEY = 'abcdef'; // too short
    expect(() => encryptCredential('test')).toThrow(CredentialError);
    expect(() => encryptCredential('test')).toThrow('64-character hex string');
  });

  it('throws CredentialError when decrypting tampered ciphertext', () => {
    const encrypted = encryptCredential('secret');
    // Tamper with the ciphertext
    const tampered = {
      ...encrypted,
      ciphertext: encrypted.ciphertext.replace(/[0-9a-f]/, (c) =>
        c === '0' ? '1' : '0',
      ),
    };
    expect(() => decryptCredential(tampered)).toThrow(CredentialError);
    expect(() => decryptCredential(tampered)).toThrow('tampered');
  });

  it('throws CredentialError when decrypting with wrong auth tag', () => {
    const encrypted = encryptCredential('secret');
    const tampered = {
      ...encrypted,
      authTag: '00'.repeat(16), // wrong tag
    };
    expect(() => decryptCredential(tampered)).toThrow(CredentialError);
  });

  it('handles empty string plaintext', () => {
    const encrypted = encryptCredential('');
    const decrypted = decryptCredential(encrypted);
    expect(decrypted).toBe('');
  });

  it('handles unicode plaintext', () => {
    const plaintext = '{"name":"Ünïcödé 🔑"}';
    const encrypted = encryptCredential(plaintext);
    const decrypted = decryptCredential(encrypted);
    expect(decrypted).toBe(plaintext);
  });
});
