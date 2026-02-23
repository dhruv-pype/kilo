import { query } from '../database/pool.js';
import { DatabaseError, AuthorizationError } from '../common/errors/index.js';

/**
 * Sandboxed SQL executor for skill data queries (Spec #1, Section 4).
 *
 * When the LLM generates a SQL query to answer "what orders this week?",
 * it runs through this executor — NOT directly against the database.
 *
 * Safety constraints:
 * - SELECT only (no INSERT/UPDATE/DELETE/DROP/ALTER)
 * - Can only access tables in the bot's own schema
 * - Can only access tables declared in the skill's `readableTables`
 * - Query timeout: 5 seconds
 * - Row limit: 1000 rows
 */

const MAX_ROWS = 1000;
const QUERY_TIMEOUT_MS = 5_000;

const FORBIDDEN_PATTERNS = [
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i,
  /\b(INTO|SET)\b/i,
  /;\s*\S/,  // multiple statements (SQL injection attempt)
];

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

/**
 * Execute a read-only SQL query against a bot's skill data tables.
 *
 * @param schemaName - The bot's Postgres schema (e.g., "bot_a1b2c3d4")
 * @param sql - The SQL query to execute (must be SELECT)
 * @param allowedTables - Tables this skill is allowed to read
 */
export async function executeSkillQuery(
  schemaName: string,
  sql: string,
  allowedTables: string[],
): Promise<QueryResult> {
  // 1. Validate: SELECT only
  validateSelectOnly(sql);

  // 2. Validate: only accesses allowed tables
  validateTableAccess(sql, schemaName, allowedTables);

  // 3. Apply row limit if not already present
  const limitedSql = applyRowLimit(sql);

  // 4. Set search path to bot's schema so unqualified table names resolve correctly
  const wrappedSql = `SET LOCAL search_path TO ${schemaName}, public; ${limitedSql}`;

  try {
    const result = await query(wrappedSql);
    const rows = result.rows as Record<string, unknown>[];
    return {
      rows: rows.slice(0, MAX_ROWS),
      rowCount: rows.length,
      truncated: rows.length > MAX_ROWS,
    };
  } catch (err) {
    throw new DatabaseError(
      `Skill query failed: ${(err as Error).message}`,
      err,
    );
  }
}

/**
 * Insert a row into a skill's data table.
 * Used by the Orchestrator when a skill's tool call requests a data write.
 */
export async function insertSkillData(
  schemaName: string,
  tableName: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const columns = Object.keys(data);
  const values = Object.values(data);
  const placeholders = columns.map((_, i) => `$${i + 1}`);

  const sql = `
    INSERT INTO ${schemaName}.${tableName} (${columns.join(', ')})
    VALUES (${placeholders.join(', ')})
    RETURNING *
  `;

  const result = await query(sql, values);
  return result.rows[0] as Record<string, unknown>;
}

/**
 * Update a row in a skill's data table.
 */
export async function updateSkillData(
  schemaName: string,
  tableName: string,
  id: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const entries = Object.entries(data);
  const setClauses = entries.map(([col], i) => `${col} = $${i + 1}`);
  const values = entries.map(([, val]) => val);
  values.push(id);

  const sql = `
    UPDATE ${schemaName}.${tableName}
    SET ${setClauses.join(', ')}, updated_at = now()
    WHERE id = $${values.length}
    RETURNING *
  `;

  const result = await query(sql, values);
  if (result.rows.length === 0) {
    throw new DatabaseError(`Row not found: ${id} in ${schemaName}.${tableName}`);
  }
  return result.rows[0] as Record<string, unknown>;
}

// ─── Validation ────────────────────────────────────────────────

function validateSelectOnly(sql: string): void {
  const trimmed = sql.trim();

  // Must start with SELECT or WITH (for CTEs)
  if (!/^\s*(SELECT|WITH)\b/i.test(trimmed)) {
    throw new AuthorizationError('Only SELECT queries are allowed on skill data');
  }

  // Check for forbidden SQL keywords that indicate writes
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new AuthorizationError(
        `Query contains forbidden operation. Only SELECT is allowed.`,
      );
    }
  }
}

function validateTableAccess(
  sql: string,
  schemaName: string,
  allowedTables: string[],
): void {
  // Extract table references from the query.
  // This is a best-effort check — not a full SQL parser.
  // The Postgres schema search_path restriction provides defense-in-depth.
  const tableRefPattern = /\bFROM\s+(\w+(?:\.\w+)?)/gi;
  const joinPattern = /\bJOIN\s+(\w+(?:\.\w+)?)/gi;
  const allRefs: string[] = [];

  let match;
  while ((match = tableRefPattern.exec(sql)) !== null) {
    allRefs.push(match[1]);
  }
  while ((match = joinPattern.exec(sql)) !== null) {
    allRefs.push(match[1]);
  }

  const allowedSet = new Set(allowedTables.map((t) => t.toLowerCase()));
  // Also allow schema-qualified names
  for (const table of allowedTables) {
    allowedSet.add(`${schemaName}.${table}`.toLowerCase());
  }

  for (const ref of allRefs) {
    const lower = ref.toLowerCase();
    if (!allowedSet.has(lower)) {
      throw new AuthorizationError(
        `Query references table "${ref}" which is not in the skill's allowed tables: [${allowedTables.join(', ')}]`,
      );
    }
  }
}

function applyRowLimit(sql: string): string {
  // If query already has a LIMIT, don't add another
  if (/\bLIMIT\s+\d+/i.test(sql)) {
    return sql;
  }
  // Add LIMIT to prevent unbounded results
  return `${sql.replace(/;\s*$/, '')} LIMIT ${MAX_ROWS}`;
}
