import { query } from '../pool.js';
import type { MemoryFact } from '../../common/types/orchestrator.js';

/**
 * Memory repository — persists and retrieves memory facts for a bot.
 *
 * Uses the `memory_facts` table (migration 001) with a unique index on
 * (bot_id, key). Upserts use ON CONFLICT to keep the higher-confidence
 * fact when the same key appears again.
 */

interface MemoryFactRow {
  fact_id: string;
  bot_id: string;
  key: string;
  value: string;
  source: string;
  confidence: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * Upsert one or more memory facts.
 * If a fact with the same (bot_id, key) already exists, only update
 * when the incoming confidence is >= the stored confidence.
 */
export async function upsertFacts(
  botId: string,
  facts: MemoryFact[],
): Promise<void> {
  if (facts.length === 0) return;

  for (const fact of facts) {
    await query(
      `INSERT INTO memory_facts (bot_id, key, value, source, confidence)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (bot_id, key)
       DO UPDATE SET
         value = CASE WHEN EXCLUDED.confidence >= memory_facts.confidence
                      THEN EXCLUDED.value
                      ELSE memory_facts.value END,
         source = CASE WHEN EXCLUDED.confidence >= memory_facts.confidence
                       THEN EXCLUDED.source
                       ELSE memory_facts.source END,
         confidence = GREATEST(EXCLUDED.confidence, memory_facts.confidence),
         updated_at = now()`,
      [botId, fact.key, fact.value, fact.source, fact.confidence],
    );
  }
}

/**
 * Get all memory facts for a bot, optionally filtered by key pattern.
 * Returns facts ordered by confidence DESC then updated_at DESC.
 *
 * @param keyQuery — optional ILIKE pattern (e.g., 'user_%' or '%name%')
 */
export async function getFactsByBotId(
  botId: string,
  keyQuery: string | null = null,
): Promise<MemoryFact[]> {
  let sql = `SELECT * FROM memory_facts WHERE bot_id = $1`;
  const params: unknown[] = [botId];

  if (keyQuery) {
    sql += ` AND key ILIKE $2`;
    params.push(`%${keyQuery}%`);
  }

  sql += ` ORDER BY confidence DESC, updated_at DESC`;

  const result = await query<MemoryFactRow>(sql, params);
  return result.rows.map(mapFactRow);
}

/**
 * Delete a single memory fact by composite key (bot_id, key).
 */
export async function deleteFact(
  botId: string,
  key: string,
): Promise<boolean> {
  const result = await query(
    `DELETE FROM memory_facts WHERE bot_id = $1 AND key = $2`,
    [botId, key],
  );
  return (result.rowCount ?? 0) > 0;
}

function mapFactRow(row: MemoryFactRow): MemoryFact {
  return {
    key: row.key,
    value: row.value,
    source: row.source as MemoryFact['source'],
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}
