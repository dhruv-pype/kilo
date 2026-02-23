/**
 * Tool Registry Repository — CRUD for external API tool registrations.
 *
 * Two views of tool data:
 *   - Redacted (ToolRegistryEntryRedacted): for API responses — no authConfig
 *   - Full (ToolRegistryEntry): for orchestrator runtime — includes encrypted authConfig
 *
 * Auth credentials are encrypted by the credential vault before storage
 * and NEVER returned in API responses.
 */

import { v4 as uuidv4 } from 'uuid';
import { query } from '../pool.js';
import { ToolNotFoundError } from '../../common/errors/index.js';
import { encryptCredential } from '../../tool-execution/credential-vault.js';
import { toolRegistryId } from '../../common/types/ids.js';
import type { BotId, ToolRegistryId } from '../../common/types/ids.js';
import type {
  ToolRegistryEntry,
  ToolRegistryEntryRedacted,
  ToolRegistryCreateInput,
  ToolRegistryUpdateInput,
  ToolEndpoint,
  AuthType,
  AuthConfig,
} from '../../common/types/tool-registry.js';

// ─── Row Shape ──────────────────────────────────────────────────

interface ToolRow {
  tool_id: string;
  bot_id: string;
  name: string;
  description: string;
  base_url: string;
  auth_type: string;
  auth_config: { encrypted: { iv: string; authTag: string; ciphertext: string } };
  endpoints: ToolEndpoint[];
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

// ─── CRUD ───────────────────────────────────────────────────────

export async function createTool(input: ToolRegistryCreateInput): Promise<ToolRegistryEntryRedacted> {
  const id = uuidv4();
  const encrypted = encryptCredential(input.authConfigPlaintext);

  const result = await query<ToolRow>(
    `INSERT INTO tool_registry (
      tool_id, bot_id, name, description, base_url, auth_type, auth_config, endpoints
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *`,
    [
      id,
      input.botId,
      input.name,
      input.description,
      input.baseUrl,
      input.authType,
      JSON.stringify({ encrypted }),
      JSON.stringify(input.endpoints),
    ],
  );

  return mapToolRowRedacted(result.rows[0]);
}

export async function getToolsByBotId(botIdValue: string): Promise<ToolRegistryEntryRedacted[]> {
  const result = await query<ToolRow>(
    'SELECT * FROM tool_registry WHERE bot_id = $1 AND is_active = true ORDER BY created_at',
    [botIdValue],
  );
  return result.rows.map(mapToolRowRedacted);
}

export async function getToolById(id: string): Promise<ToolRegistryEntryRedacted> {
  const result = await query<ToolRow>(
    'SELECT * FROM tool_registry WHERE tool_id = $1',
    [id],
  );
  if (result.rows.length === 0) throw new ToolNotFoundError(id);
  return mapToolRowRedacted(result.rows[0]);
}

/**
 * Load full tool entries (with encrypted authConfig) for runtime use.
 * Only the orchestrator should call this — never return raw auth to API clients.
 */
export async function getToolsByNames(botIdValue: string, names: string[]): Promise<ToolRegistryEntry[]> {
  if (names.length === 0) return [];
  const placeholders = names.map((_, i) => `$${i + 2}`).join(', ');
  const result = await query<ToolRow>(
    `SELECT * FROM tool_registry WHERE bot_id = $1 AND name IN (${placeholders}) AND is_active = true`,
    [botIdValue, ...names],
  );
  return result.rows.map(mapToolRowFull);
}

export async function updateTool(id: string, updates: ToolRegistryUpdateInput): Promise<ToolRegistryEntryRedacted> {
  const fieldMap: Record<string, string> = {
    name: 'name',
    description: 'description',
    baseUrl: 'base_url',
    authType: 'auth_type',
    endpoints: 'endpoints',
    isActive: 'is_active',
  };

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && key !== 'authConfigPlaintext' && fieldMap[key]) {
      const dbValue = key === 'endpoints' ? JSON.stringify(value) : value;
      setClauses.push(`${fieldMap[key]} = $${paramIndex}`);
      values.push(dbValue);
      paramIndex++;
    }
  }

  // Handle credential re-encryption
  if (updates.authConfigPlaintext) {
    const encrypted = encryptCredential(updates.authConfigPlaintext);
    setClauses.push(`auth_config = $${paramIndex}`);
    values.push(JSON.stringify({ encrypted }));
    paramIndex++;
  }

  if (setClauses.length === 0) return getToolById(id);

  setClauses.push(`updated_at = now()`);
  values.push(id);

  const result = await query<ToolRow>(
    `UPDATE tool_registry SET ${setClauses.join(', ')} WHERE tool_id = $${paramIndex} RETURNING *`,
    values,
  );

  if (result.rows.length === 0) throw new ToolNotFoundError(id);
  return mapToolRowRedacted(result.rows[0]);
}

export async function deleteTool(id: string): Promise<void> {
  const result = await query('DELETE FROM tool_registry WHERE tool_id = $1', [id]);
  if (result.rowCount === 0) throw new ToolNotFoundError(id);
}

// ─── Row Mapping ────────────────────────────────────────────────

function mapToolRowRedacted(row: ToolRow): ToolRegistryEntryRedacted {
  return {
    toolId: toolRegistryId(row.tool_id),
    botId: row.bot_id as BotId,
    name: row.name,
    description: row.description,
    baseUrl: row.base_url,
    authType: row.auth_type as AuthType,
    endpoints: row.endpoints,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapToolRowFull(row: ToolRow): ToolRegistryEntry {
  return {
    ...mapToolRowRedacted(row),
    authConfig: row.auth_config as AuthConfig,
  } as ToolRegistryEntry;
}
