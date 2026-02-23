import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../pool.js';
import { BotNotFoundError, SchemaCreationError } from '../../common/errors/index.js';
import type { BotConfig, BotCreateInput } from '../../common/types/bot.js';
import type { SoulDefinition } from '../../common/types/soul.js';
import { botId } from '../../common/types/ids.js';

/** Row shape returned by all bot queries */
interface BotRow {
  bot_id: string;
  user_id: string;
  name: string;
  description: string;
  personality: string;
  context: string;
  soul: Record<string, unknown> | null;
  schema_name: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Generates the Postgres schema name for a bot.
 * Uses first 8 chars of UUID for readability while avoiding collisions.
 */
function toBotSchemaName(id: string): string {
  return `bot_${id.replace(/-/g, '').slice(0, 8)}`;
}

export async function createBot(input: BotCreateInput): Promise<BotConfig> {
  const id = uuidv4();
  const schemaName = toBotSchemaName(id);

  return withTransaction(async (client) => {
    // Create the bot row
    const result = await client.query<BotRow>(
      `INSERT INTO bots (bot_id, user_id, name, description, personality, context, soul, schema_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [id, input.userId, input.name, input.description, input.personality, input.context, input.soul ? JSON.stringify(input.soul) : null, schemaName],
    );

    // Create the bot-specific Postgres schema (Spec #1)
    // This is where all skill data tables will live.
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
    } catch (err) {
      throw new SchemaCreationError(schemaName, err);
    }

    return mapBotRow(result.rows[0]);
  });
}

export async function getBotById(id: string): Promise<BotConfig> {
  const result = await query<BotRow>(
    'SELECT * FROM bots WHERE bot_id = $1',
    [id],
  );

  if (result.rows.length === 0) {
    throw new BotNotFoundError(id);
  }

  return mapBotRow(result.rows[0]);
}

export async function getBotsByUserId(userId: string): Promise<BotConfig[]> {
  const result = await query<BotRow>(
    'SELECT * FROM bots WHERE user_id = $1 AND is_active = true ORDER BY created_at DESC',
    [userId],
  );

  return result.rows.map(mapBotRow);
}

export async function updateBot(
  id: string,
  updates: Partial<Pick<BotConfig, 'name' | 'description' | 'personality' | 'context' | 'soul'>>,
): Promise<BotConfig> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      setClauses.push(`${toSnakeCase(key)} = $${paramIndex}`);
      // Serialize soul JSONB before sending to Postgres
      values.push(key === 'soul' ? JSON.stringify(value) : value);
      paramIndex++;
    }
  }

  if (setClauses.length === 0) {
    return getBotById(id);
  }

  setClauses.push(`updated_at = now()`);
  values.push(id);

  const result = await query<BotRow>(
    `UPDATE bots SET ${setClauses.join(', ')} WHERE bot_id = $${paramIndex} RETURNING *`,
    values,
  );

  if (result.rows.length === 0) {
    throw new BotNotFoundError(id);
  }

  return mapBotRow(result.rows[0]);
}

export async function deleteBot(id: string): Promise<void> {
  const bot = await getBotById(id);

  await withTransaction(async (client) => {
    // Drop the bot's Postgres schema and all its skill data tables
    await client.query(`DROP SCHEMA IF EXISTS ${bot.schemaName} CASCADE`);
    // Delete the bot (cascades to skills, messages, memory_facts)
    await client.query('DELETE FROM bots WHERE bot_id = $1', [id]);
  });
}

function mapBotRow(row: BotRow): BotConfig {
  return {
    botId: botId(row.bot_id),
    userId: row.user_id as any,
    name: row.name,
    description: row.description,
    personality: row.personality,
    context: row.context,
    soul: (row.soul as SoulDefinition | null) ?? null,
    schemaName: row.schema_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
