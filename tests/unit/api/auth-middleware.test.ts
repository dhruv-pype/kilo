import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractBotId, verifyBotOwnership } from '@api/middleware/ownership.js';
import type { FastifyRequest } from 'fastify';

// Mock bot repository
vi.mock('@database/repositories/bot-repository.js', () => ({
  getBotById: vi.fn(),
}));

import * as botRepo from '@database/repositories/bot-repository.js';

// ─── extractBotId ────────────────────────────────────────────

describe('extractBotId', () => {
  it('extracts botId from route params', () => {
    const request = {
      params: { botId: 'bot-abc' },
      body: undefined,
    } as unknown as FastifyRequest;

    expect(extractBotId(request)).toBe('bot-abc');
  });

  it('extracts botId from request body', () => {
    const request = {
      params: {},
      body: { botId: 'bot-xyz', content: 'hello' },
    } as unknown as FastifyRequest;

    expect(extractBotId(request)).toBe('bot-xyz');
  });

  it('prefers params over body', () => {
    const request = {
      params: { botId: 'from-params' },
      body: { botId: 'from-body' },
    } as unknown as FastifyRequest;

    expect(extractBotId(request)).toBe('from-params');
  });

  it('returns null when no botId is present', () => {
    const request = {
      params: {},
      body: { content: 'hello' },
    } as unknown as FastifyRequest;

    expect(extractBotId(request)).toBeNull();
  });

  it('returns null when body is undefined', () => {
    const request = {
      params: {},
      body: undefined,
    } as unknown as FastifyRequest;

    expect(extractBotId(request)).toBeNull();
  });
});

// ─── verifyBotOwnership ──────────────────────────────────────

describe('verifyBotOwnership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes when userId matches bot owner', async () => {
    vi.mocked(botRepo.getBotById).mockResolvedValue({
      botId: 'bot-123' as any,
      userId: 'user-abc' as any,
      name: 'Test Bot',
      description: '',
      personality: '',
      context: '',
      schemaName: 'bot_abc',
      isActive: true,
      soul: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(verifyBotOwnership('user-abc', 'bot-123')).resolves.toBeUndefined();
  });

  it('throws AuthorizationError when userId does not match', async () => {
    vi.mocked(botRepo.getBotById).mockResolvedValue({
      botId: 'bot-123' as any,
      userId: 'user-abc' as any,
      name: 'Test Bot',
      description: '',
      personality: '',
      context: '',
      schemaName: 'bot_abc',
      isActive: true,
      soul: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(verifyBotOwnership('user-DIFFERENT', 'bot-123'))
      .rejects.toThrow('You do not own this bot');
  });

  it('propagates BotNotFoundError if bot does not exist', async () => {
    vi.mocked(botRepo.getBotById).mockRejectedValue(new Error('Bot not found: bot-999'));

    await expect(verifyBotOwnership('user-abc', 'bot-999'))
      .rejects.toThrow('Bot not found');
  });
});
