import { query, withTransaction } from '../pool.js';
import type { SkillDataSnapshot, TableSchema } from '../../common/types/orchestrator.js';

/**
 * Skill data repository — read/write access to bot-schema data tables.
 *
 * Each bot has its own Postgres schema (e.g. "bot_abc12345"). Skill data
 * tables live inside that schema, not in public. Schema isolation provides
 * per-bot data separation without needing RLS on these tables.
 *
 * All table/column name inputs are validated as safe SQL identifiers before
 * use in dynamic queries. SQL from the LLM (executeSelectQuery) is restricted
 * to SELECT statements only.
 */

const MAX_SNAPSHOT_ROWS = 20;
const MAX_QUERY_ROWS = 100;

/**
 * Validate that a name is a safe SQL identifier (alphanumeric + underscore,
 * must start with a letter or underscore). Prevents injection via dynamic
 * table/column names.
 */
function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

/**
 * Load a snapshot of the skill's data table: recent rows + total count.
 * Used to give the LLM context about existing data before responding.
 * Returns empty snapshot if the table doesn't exist yet.
 */
export async function loadSkillData(
  schemaName: string,
  tableName: string,
  _dataQuery: string | null,
): Promise<SkillDataSnapshot> {
  if (!isValidIdentifier(schemaName) || !isValidIdentifier(tableName)) {
    return { tableName, rows: [], totalCount: 0 };
  }

  const fullTable = `"${schemaName}"."${tableName}"`;

  try {
    const [countResult, rowsResult] = await Promise.all([
      query<{ count: string }>(`SELECT COUNT(*) FROM ${fullTable}`, []),
      query<Record<string, unknown>>(
        `SELECT * FROM ${fullTable} ORDER BY created_at DESC LIMIT ${MAX_SNAPSHOT_ROWS}`,
        [],
      ),
    ]);

    return {
      tableName,
      rows: rowsResult.rows,
      totalCount: parseInt(countResult.rows[0].count, 10),
    };
  } catch {
    // Table doesn't exist yet — skill was just created but hasn't stored data
    return { tableName, rows: [], totalCount: 0 };
  }
}

/**
 * Load column schemas for a set of skill data tables.
 * Used to inject table structure into the prompt so the LLM can write valid SQL.
 */
export async function loadTableSchemas(
  schemaName: string,
  tableNames: string[],
): Promise<TableSchema[]> {
  if (!isValidIdentifier(schemaName) || tableNames.length === 0) return [];

  const validNames = tableNames.filter(isValidIdentifier);
  if (validNames.length === 0) return [];

  const result = await query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = ANY($2)
     ORDER BY table_name, ordinal_position`,
    [schemaName, validNames],
  );

  // Group columns by table
  const schemaMap = new Map<string, TableSchema>();
  for (const row of result.rows) {
    if (!schemaMap.has(row.table_name)) {
      schemaMap.set(row.table_name, { tableName: row.table_name, columns: [] });
    }
    schemaMap.get(row.table_name)!.columns.push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
    });
  }

  return Array.from(schemaMap.values());
}

/**
 * Execute a SELECT query against the bot's skill data tables.
 * SQL originates from the LLM — strictly enforced as SELECT-only.
 *
 * Uses SET LOCAL search_path inside a transaction so unqualified table names
 * in the LLM-generated SQL resolve to the correct bot schema without leaking
 * the search_path to other pool connections.
 */
export async function executeSelectQuery(
  schemaName: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  if (!isValidIdentifier(schemaName)) {
    throw new Error('Invalid schema name');
  }

  const trimmed = sql.trim();

  // Must be a SELECT statement
  if (!/^SELECT\b/i.test(trimmed)) {
    throw new Error('Only SELECT queries are allowed in query_skill_data');
  }

  // Block any DML or DDL keywords anywhere in the query
  const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|COPY|EXECUTE|CALL)\b/i;
  if (forbidden.test(trimmed)) {
    throw new Error('Forbidden SQL keyword in query_skill_data');
  }

  return withTransaction(async (client) => {
    // SET LOCAL scopes search_path to this transaction only — safe with connection pooling
    await client.query(`SET LOCAL search_path TO "${schemaName}", public`);

    // Append LIMIT if the LLM didn't include one
    const hasLimit = /\bLIMIT\b/i.test(trimmed);
    const safeSQL = hasLimit ? trimmed : `${trimmed} LIMIT ${MAX_QUERY_ROWS}`;

    const result = await client.query<Record<string, unknown>>(safeSQL, []);
    return result.rows;
  });
}

/**
 * Insert a row into a skill data table.
 * Column names from the LLM are validated before use in the dynamic query.
 */
export async function insertRow(
  schemaName: string,
  tableName: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!isValidIdentifier(schemaName) || !isValidIdentifier(tableName)) {
    throw new Error(`Invalid schema or table name: ${schemaName}.${tableName}`);
  }

  const fullTable = `"${schemaName}"."${tableName}"`;

  // Exclude 'id', 'created_at', 'updated_at' — table defaults handle these
  const keys = Object.keys(data).filter(
    (k) => isValidIdentifier(k) && !['id', 'created_at', 'updated_at'].includes(k),
  );

  if (keys.length === 0) {
    throw new Error('No valid columns provided for insert');
  }

  const values = keys.map((k) => data[k]);
  const cols = keys.map((k) => `"${k}"`).join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

  await query(`INSERT INTO ${fullTable} (${cols}) VALUES (${placeholders})`, values);
}

/**
 * Update a row in a skill data table by its UUID primary key.
 */
export async function updateRow(
  schemaName: string,
  tableName: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!isValidIdentifier(schemaName) || !isValidIdentifier(tableName)) {
    throw new Error(`Invalid schema or table name: ${schemaName}.${tableName}`);
  }

  const fullTable = `"${schemaName}"."${tableName}"`;

  const keys = Object.keys(data).filter(
    (k) => isValidIdentifier(k) && !['id', 'created_at'].includes(k),
  );

  if (keys.length === 0) {
    throw new Error('No valid columns provided for update');
  }

  const values = keys.map((k) => data[k]);
  const setClauses = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');

  await query(
    `UPDATE ${fullTable} SET ${setClauses}, updated_at = now() WHERE id = $${keys.length + 1}`,
    [...values, id],
  );
}
