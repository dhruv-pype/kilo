import { query, withTransaction } from '../database/pool.js';
import { DatabaseError } from '../common/errors/index.js';

/**
 * Schema Generator — Spec #1 core implementation.
 *
 * Converts a skill's JSON Schema `inputSchema` into a real PostgreSQL table
 * inside the bot's dedicated schema namespace. This is what makes
 * "Sarah teaches her bot to track orders" produce a queryable SQL table
 * instead of an opaque JSON blob.
 *
 * Mapping rules (from Spec #1):
 *   string            → TEXT
 *   string+date       → DATE
 *   string+date-time  → TIMESTAMPTZ
 *   string+enum       → TEXT + CHECK
 *   number            → DOUBLE PRECISION
 *   integer           → INTEGER
 *   boolean           → BOOLEAN
 *   array             → JSONB  (arrays stay as JSONB — simple enough)
 *   object (nested)   → JSONB  (nested objects stay as JSONB)
 */

// ─── Public API ────────────────────────────────────────────────

export interface GeneratedTable {
  tableName: string;       // fully qualified: "bot_a1b2c3d4.orders"
  shortName: string;       // just "orders"
  ddl: string;             // the CREATE TABLE statement
  columns: ColumnInfo[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
}

/**
 * Generate a table DDL from a JSON Schema and create it in the database.
 * Returns the table metadata for storage on the Skill Definition Object.
 */
export async function createSkillTable(
  schemaName: string,
  skillName: string,
  skillId: string,
  inputSchema: Record<string, unknown>,
): Promise<GeneratedTable> {
  const shortName = await resolveTableName(schemaName, skillName);
  const fullName = `${schemaName}.${shortName}`;
  const { ddl, columns } = generateDDL(schemaName, shortName, skillId, inputSchema);

  try {
    await query(ddl);
  } catch (err) {
    throw new DatabaseError(
      `Failed to create skill table ${fullName}: ${(err as Error).message}`,
      err,
    );
  }

  return { tableName: fullName, shortName, ddl, columns };
}

/**
 * Add a column to an existing skill table.
 * Used when a user refines a skill: "also track the deposit amount."
 * Never drops columns — only adds (Spec #1: column removal is never automatic).
 */
export async function addColumn(
  schemaName: string,
  tableName: string,
  columnName: string,
  jsonSchemaType: Record<string, unknown>,
  required: boolean,
): Promise<string> {
  const pgType = mapJsonTypeToPg(jsonSchemaType);
  const safeName = sanitizeIdentifier(columnName);
  const nullClause = required ? 'NOT NULL' : '';
  const checkClause = buildCheckClause(safeName, jsonSchemaType);

  const alterSql = `ALTER TABLE ${schemaName}.${tableName} ADD COLUMN ${safeName} ${pgType} ${nullClause} ${checkClause}`.replace(/\s+/g, ' ').trim();

  await query(alterSql);
  return alterSql;
}

/**
 * Drop a skill's data table entirely.
 * Used when a skill is deleted.
 */
export async function dropSkillTable(
  schemaName: string,
  tableName: string,
): Promise<void> {
  await query(`DROP TABLE IF EXISTS ${schemaName}.${tableName}`);
}

/**
 * Get the column definitions of an existing table.
 * Used to provide table schemas to the PromptComposer so the LLM
 * can generate valid SQL queries.
 */
export async function getTableColumns(
  schemaName: string,
  tableName: string,
): Promise<ColumnInfo[]> {
  const result = await query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schemaName, tableName],
  );

  return result.rows.map((r) => ({
    name: r.column_name,
    type: r.data_type,
    nullable: r.is_nullable === 'YES',
  }));
}

// ─── DDL Generation ────────────────────────────────────────────

function generateDDL(
  schemaName: string,
  tableName: string,
  skillId: string,
  inputSchema: Record<string, unknown>,
): { ddl: string; columns: ColumnInfo[] } {
  const properties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((inputSchema.required ?? []) as string[]);

  const columns: ColumnInfo[] = [];
  const columnDefs: string[] = [];

  // Standard columns every skill table gets
  columnDefs.push(`id UUID PRIMARY KEY DEFAULT gen_random_uuid()`);
  columns.push({ name: 'id', type: 'uuid', nullable: false });

  // User-defined columns from inputSchema
  for (const [propName, propSchema] of Object.entries(properties)) {
    const safeName = sanitizeIdentifier(propName);
    const pgType = mapJsonTypeToPg(propSchema);
    const isRequired = required.has(propName);
    const nullClause = isRequired ? 'NOT NULL' : '';
    const checkClause = buildCheckClause(safeName, propSchema);

    columnDefs.push(`${safeName} ${pgType} ${nullClause} ${checkClause}`.replace(/\s+/g, ' ').trim());
    columns.push({ name: safeName, type: pgType, nullable: !isRequired });
  }

  // Audit columns
  columnDefs.push(`created_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
  columnDefs.push(`updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
  columnDefs.push(`skill_id UUID NOT NULL DEFAULT '${skillId}'::uuid`);
  columns.push({ name: 'created_at', type: 'timestamptz', nullable: false });
  columns.push({ name: 'updated_at', type: 'timestamptz', nullable: false });
  columns.push({ name: 'skill_id', type: 'uuid', nullable: false });

  const fullName = `${schemaName}.${tableName}`;
  let ddl = `CREATE TABLE ${fullName} (\n  ${columnDefs.join(',\n  ')}\n);\n`;

  // Auto-generate indexes (Spec #1):
  // - All date/datetime columns get a B-tree index
  // - All required columns get a B-tree index
  const indexStatements: string[] = [];
  for (const [propName, propSchema] of Object.entries(properties)) {
    const safeName = sanitizeIdentifier(propName);
    const format = propSchema.format as string | undefined;
    const isDateLike = format === 'date' || format === 'date-time';
    const isRequired = required.has(propName);
    const pgType = mapJsonTypeToPg(propSchema);

    // Only index scalar types (not JSONB)
    if ((isDateLike || isRequired) && pgType !== 'JSONB') {
      indexStatements.push(
        `CREATE INDEX idx_${tableName}_${safeName} ON ${fullName}(${safeName});`,
      );
    }
  }

  if (indexStatements.length > 0) {
    ddl += '\n' + indexStatements.join('\n') + '\n';
  }

  return { ddl, columns };
}

// ─── Type Mapping ──────────────────────────────────────────────

function mapJsonTypeToPg(schema: Record<string, unknown>): string {
  const type = schema.type as string;
  const format = schema.format as string | undefined;

  switch (type) {
    case 'string':
      if (format === 'date') return 'DATE';
      if (format === 'date-time') return 'TIMESTAMPTZ';
      return 'TEXT';
    case 'number':
      return 'DOUBLE PRECISION';
    case 'integer':
      return 'INTEGER';
    case 'boolean':
      return 'BOOLEAN';
    case 'array':
      return 'JSONB';
    case 'object':
      return 'JSONB';
    default:
      return 'TEXT';
  }
}

function buildCheckClause(columnName: string, schema: Record<string, unknown>): string {
  const enumValues = schema.enum as string[] | undefined;
  if (enumValues && Array.isArray(enumValues)) {
    const escaped = enumValues.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
    return `CHECK (${columnName} IN (${escaped}))`;
  }
  return '';
}

// ─── Naming ────────────────────────────────────────────────────

/**
 * Convert a skill name to a valid, non-colliding SQL table name.
 * "Order Tracker" → "orders"
 * Handles collisions by appending a numeric suffix.
 */
async function resolveTableName(schemaName: string, skillName: string): Promise<string> {
  const base = toTableName(skillName);
  const existing = await getExistingTableNames(schemaName);

  if (!existing.has(base)) {
    return base;
  }

  // Collision: append numeric suffix
  for (let i = 2; i <= 100; i++) {
    const candidate = `${base}_${i}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }

  throw new DatabaseError(`Could not resolve unique table name for "${skillName}" in ${schemaName}`);
}

function toTableName(skillName: string): string {
  return skillName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')  // strip special chars
    .trim()
    .replace(/\s+/g, '_')          // spaces to underscores
    .replace(/(_tracker|_log|_manager|_builder|_planner)$/, '') // strip common suffixes
    .replace(/_+$/, '')
    + 's';                          // pluralize (simple — not perfect, but good enough)
}

async function getExistingTableNames(schemaName: string): Promise<Set<string>> {
  const result = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
    [schemaName],
  );
  return new Set(result.rows.map((r) => r.table_name));
}

// ─── SQL Safety ────────────────────────────────────────────────

const SQL_RESERVED_WORDS = new Set([
  'select', 'from', 'where', 'insert', 'update', 'delete', 'drop', 'create',
  'table', 'index', 'order', 'group', 'by', 'having', 'join', 'on', 'and',
  'or', 'not', 'null', 'true', 'false', 'in', 'between', 'like', 'is',
  'as', 'case', 'when', 'then', 'else', 'end', 'limit', 'offset', 'union',
  'all', 'any', 'exists', 'user', 'default', 'check', 'primary', 'key',
  'foreign', 'references', 'constraint', 'unique', 'column', 'value',
]);

function sanitizeIdentifier(name: string): string {
  let safe = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
    .replace(/_{2,}/g, '_');

  // Prefix reserved words to avoid SQL errors
  if (SQL_RESERVED_WORDS.has(safe)) {
    safe = `col_${safe}`;
  }

  // Postgres identifier limit is 63 chars
  if (safe.length > 63) {
    safe = safe.slice(0, 63);
  }

  // Must start with a letter
  if (!/^[a-z]/.test(safe)) {
    safe = `col_${safe}`;
  }

  return safe;
}
