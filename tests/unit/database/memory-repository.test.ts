import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database pool before importing the repository
vi.mock('@database/pool.js', () => ({
  query: vi.fn(),
}));

import { upsertFacts, getFactsByBotId, deleteFact } from '@database/repositories/memory-repository.js';
import { query } from '@database/pool.js';
import type { MemoryFact } from '@common/types/orchestrator.js';

const mockQuery = vi.mocked(query);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('upsertFacts', () => {
  it('inserts each fact with ON CONFLICT upsert', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] });

    const facts: MemoryFact[] = [
      { key: 'user_name', value: 'Dhruv', source: 'user_stated', confidence: 0.9, createdAt: new Date() },
      { key: 'location', value: 'Austin', source: 'inferred', confidence: 0.7, createdAt: new Date() },
    ];

    await upsertFacts('bot-123', facts);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    // First call should be for user_name
    expect(mockQuery.mock.calls[0][1]).toEqual(['bot-123', 'user_name', 'Dhruv', 'user_stated', 0.9]);
    // Second call should be for location
    expect(mockQuery.mock.calls[1][1]).toEqual(['bot-123', 'location', 'Austin', 'inferred', 0.7]);
  });

  it('does nothing for empty facts array', async () => {
    await upsertFacts('bot-123', []);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('SQL includes ON CONFLICT for upsert behavior', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] });

    await upsertFacts('bot-123', [
      { key: 'test', value: 'val', source: 'user_stated', confidence: 0.9, createdAt: new Date() },
    ]);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('GREATEST');
  });
});

describe('getFactsByBotId', () => {
  it('returns mapped facts ordered by confidence', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { fact_id: 'f1', bot_id: 'bot-123', key: 'user_name', value: 'Dhruv', source: 'user_stated', confidence: 0.9, created_at: new Date(), updated_at: new Date() },
        { fact_id: 'f2', bot_id: 'bot-123', key: 'location', value: 'Austin', source: 'inferred', confidence: 0.7, created_at: new Date(), updated_at: new Date() },
      ],
      rowCount: 2,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    const facts = await getFactsByBotId('bot-123');

    expect(facts).toHaveLength(2);
    expect(facts[0].key).toBe('user_name');
    expect(facts[0].value).toBe('Dhruv');
    expect(facts[0].source).toBe('user_stated');
    expect(facts[0].confidence).toBe(0.9);
    expect(facts[1].key).toBe('location');
  });

  it('queries without filter when keyQuery is null', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });

    await getFactsByBotId('bot-123', null);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).not.toContain('ILIKE');
    expect(mockQuery.mock.calls[0][1]).toEqual(['bot-123']);
  });

  it('applies ILIKE filter when keyQuery is provided', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });

    await getFactsByBotId('bot-123', 'user');

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ILIKE');
    expect(mockQuery.mock.calls[0][1]).toEqual(['bot-123', '%user%']);
  });

  it('returns empty array when no facts exist', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });

    const facts = await getFactsByBotId('bot-123');
    expect(facts).toEqual([]);
  });
});

describe('deleteFact', () => {
  it('returns true when a fact is deleted', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1, command: 'DELETE', oid: 0, fields: [] });

    const result = await deleteFact('bot-123', 'user_name');

    expect(result).toBe(true);
    expect(mockQuery.mock.calls[0][1]).toEqual(['bot-123', 'user_name']);
  });

  it('returns false when no fact matches', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0, command: 'DELETE', oid: 0, fields: [] });

    const result = await deleteFact('bot-123', 'nonexistent');

    expect(result).toBe(false);
  });
});
