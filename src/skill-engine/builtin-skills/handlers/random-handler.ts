/**
 * Built-in Random & UUID handler — Phase 3.6
 *
 * Handles: "generate a UUID", "random number between 1 and 100", "generate a password"
 * Uses Node.js crypto — no external deps.
 */

import crypto from 'node:crypto';
import type { ProcessedResponse } from '../../../common/types/orchestrator.js';
import type { SkillId } from '../../../common/types/ids.js';
import type { BuiltInSkillConfig } from '../types.js';

// ─── Request classification ──────────────────────────────────────

type RandomRequest =
  | { type: 'uuid' }
  | { type: 'number'; min: number; max: number }
  | { type: 'password'; length: number };

export function classifyRequest(message: string): RandomRequest {
  const lower = message.toLowerCase();

  // UUID detection
  if (/\buuid\b/i.test(lower) || /\bguid\b/i.test(lower)) {
    return { type: 'uuid' };
  }

  // Password detection
  if (/\bpassword\b/i.test(lower)) {
    const lengthMatch = lower.match(/(\d+)\s*(?:char(?:acter)?s?|digits?|long|length)/);
    const length = lengthMatch ? parseInt(lengthMatch[1], 10) : 16;
    return { type: 'password', length: Math.min(Math.max(length, 8), 128) };
  }

  // Number detection — extract range
  const betweenMatch = lower.match(/between\s+(\d+)\s+and\s+(\d+)/);
  if (betweenMatch) {
    const a = parseInt(betweenMatch[1], 10);
    const b = parseInt(betweenMatch[2], 10);
    return { type: 'number', min: Math.min(a, b), max: Math.max(a, b) };
  }

  // "random number 1 to 50" or "1-50"
  const rangeMatch = lower.match(/(\d+)\s*(?:to|-)\s*(\d+)/);
  if (rangeMatch) {
    const a = parseInt(rangeMatch[1], 10);
    const b = parseInt(rangeMatch[2], 10);
    return { type: 'number', min: Math.min(a, b), max: Math.max(a, b) };
  }

  // Default: random number 1-100
  if (/\bnumber\b/i.test(lower) || /\brandom\b/i.test(lower)) {
    return { type: 'number', min: 1, max: 100 };
  }

  // Fallback to UUID if nothing else matches
  return { type: 'uuid' };
}

// ─── Generators ──────────────────────────────────────────────────

function generateUUID(): string {
  return crypto.randomUUID();
}

function generateRandomNumber(min: number, max: number): number {
  // crypto-safe random integer in [min, max]
  const range = max - min + 1;
  const bytesNeeded = Math.ceil(Math.log2(range) / 8) || 1;
  const maxValid = Math.floor(256 ** bytesNeeded / range) * range;

  let value: number;
  do {
    const bytes = crypto.randomBytes(bytesNeeded);
    value = 0;
    for (let i = 0; i < bytesNeeded; i++) {
      value = value * 256 + bytes[i];
    }
  } while (value >= maxValid);

  return min + (value % range);
}

function generatePassword(length: number): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*_+-=';
  const bytes = crypto.randomBytes(length);
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset[bytes[i] % charset.length];
  }
  return password;
}

// ─── Handler ─────────────────────────────────────────────────────

export function handleRandom(userMessage: string): ProcessedResponse {
  const request = classifyRequest(userMessage);

  switch (request.type) {
    case 'uuid': {
      const uuid = generateUUID();
      return {
        content: `Here's your UUID:\n\n\`${uuid}\``,
        format: 'text',
        structuredData: { uuid },
        skillId: 'builtin-random' as SkillId,
        suggestedActions: ['Generate another UUID'],
      };
    }

    case 'number': {
      const number = generateRandomNumber(request.min, request.max);
      return {
        content: `Your random number (${request.min}–${request.max}): **${number}**`,
        format: 'text',
        structuredData: { number, min: request.min, max: request.max },
        skillId: 'builtin-random' as SkillId,
        suggestedActions: ['Generate another number'],
      };
    }

    case 'password': {
      const password = generatePassword(request.length);
      return {
        content: `Here's your ${request.length}-character password:\n\n\`${password}\``,
        format: 'text',
        structuredData: { password, length: request.length },
        skillId: 'builtin-random' as SkillId,
        suggestedActions: ['Generate another password'],
      };
    }
  }
}

// ─── Skill config (registered by index.ts) ───────────────────────

export const RANDOM_SKILL_CONFIG: BuiltInSkillConfig = {
  name: 'Random & UUID',
  description: 'Generate UUIDs, random numbers, and secure passwords',
  triggerPatterns: [
    'generate uuid',
    'random uuid',
    'new uuid',
    'random number',
    'generate number',
    'random between',
    'generate password',
    'random password',
    'new password',
    'generate guid',
  ],
  behaviorPrompt: 'Generate random values.',
  inputSchema: null,
  outputFormat: 'text',
  schedule: null,
  dataTable: null,
  readableTables: [],
  tableSchema: null,
  requiredIntegrations: [],
};
