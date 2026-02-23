import { v4 as uuidv4 } from 'uuid';
import { query } from '../pool.js';
import { SkillNotFoundError } from '../../common/errors/index.js';
import type { SkillDefinition, SkillCreateInput } from '../../common/types/skill.js';
import { skillId } from '../../common/types/ids.js';
import type { BotId, SkillId } from '../../common/types/ids.js';

export async function createSkill(input: SkillCreateInput & {
  dataTable: string | null;
  tableSchema: string | null;
}): Promise<SkillDefinition> {
  const id = uuidv4();

  const result = await query<SkillRow>(
    `INSERT INTO skills (
      skill_id, bot_id, name, description, trigger_patterns, behavior_prompt,
      input_schema, output_format, schedule, data_table, readable_tables,
      table_schema_ddl, required_integrations, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *`,
    [
      id,
      input.botId,
      input.name,
      input.description,
      input.triggerPatterns,
      input.behaviorPrompt,
      input.inputSchema ? JSON.stringify(input.inputSchema) : null,
      input.outputFormat,
      input.schedule,
      input.dataTable,
      input.readableTables,
      input.tableSchema,
      input.requiredIntegrations ?? [],
      input.createdBy,
    ],
  );

  return mapSkillRow(result.rows[0]);
}

export async function getSkillById(id: string): Promise<SkillDefinition> {
  const result = await query<SkillRow>(
    'SELECT * FROM skills WHERE skill_id = $1',
    [id],
  );

  if (result.rows.length === 0) {
    throw new SkillNotFoundError(id);
  }

  return mapSkillRow(result.rows[0]);
}

export async function getActiveSkillsByBotId(botIdValue: string): Promise<SkillDefinition[]> {
  const result = await query<SkillRow>(
    'SELECT * FROM skills WHERE bot_id = $1 AND is_active = true ORDER BY created_at',
    [botIdValue],
  );

  return result.rows.map(mapSkillRow);
}

export async function updateSkill(
  id: string,
  updates: Partial<Pick<SkillDefinition,
    'name' | 'description' | 'triggerPatterns' | 'behaviorPrompt' |
    'inputSchema' | 'outputFormat' | 'schedule' | 'readableTables' |
    'performanceScore' | 'isActive'
  >>,
): Promise<SkillDefinition> {
  const fieldMap: Record<string, string> = {
    name: 'name',
    description: 'description',
    triggerPatterns: 'trigger_patterns',
    behaviorPrompt: 'behavior_prompt',
    inputSchema: 'input_schema',
    outputFormat: 'output_format',
    schedule: 'schedule',
    readableTables: 'readable_tables',
    performanceScore: 'performance_score',
    isActive: 'is_active',
  };

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && fieldMap[key]) {
      const dbValue = key === 'inputSchema' ? JSON.stringify(value) : value;
      setClauses.push(`${fieldMap[key]} = $${paramIndex}`);
      values.push(dbValue);
      paramIndex++;
    }
  }

  if (setClauses.length === 0) {
    return getSkillById(id);
  }

  // Increment version on every update
  setClauses.push(`version = version + 1`);
  setClauses.push(`updated_at = now()`);
  values.push(id);

  const result = await query<SkillRow>(
    `UPDATE skills SET ${setClauses.join(', ')} WHERE skill_id = $${paramIndex} RETURNING *`,
    values,
  );

  if (result.rows.length === 0) {
    throw new SkillNotFoundError(id);
  }

  return mapSkillRow(result.rows[0]);
}

export async function deleteSkill(id: string): Promise<void> {
  const result = await query('DELETE FROM skills WHERE skill_id = $1', [id]);
  if (result.rowCount === 0) {
    throw new SkillNotFoundError(id);
  }
}

export async function countSkillsByBotId(botIdValue: string): Promise<number> {
  const result = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM skills WHERE bot_id = $1 AND is_active = true',
    [botIdValue],
  );
  return parseInt(result.rows[0].count, 10);
}

// ─── Internal ──────────────────────────────────────────────────

interface SkillRow {
  skill_id: string;
  bot_id: string;
  name: string;
  description: string;
  trigger_patterns: string[];
  behavior_prompt: string;
  input_schema: Record<string, unknown> | null;
  output_format: string;
  schedule: string | null;
  data_table: string | null;
  readable_tables: string[];
  table_schema_ddl: string | null;
  required_integrations: string[];
  created_by: string;
  version: number;
  performance_score: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function mapSkillRow(row: SkillRow): SkillDefinition {
  return {
    skillId: skillId(row.skill_id),
    botId: row.bot_id as BotId,
    name: row.name,
    description: row.description,
    triggerPatterns: row.trigger_patterns,
    behaviorPrompt: row.behavior_prompt,
    inputSchema: row.input_schema,
    outputFormat: row.output_format as SkillDefinition['outputFormat'],
    schedule: row.schedule,
    dataTable: row.data_table,
    readableTables: row.readable_tables,
    tableSchema: row.table_schema_ddl,
    requiredIntegrations: row.required_integrations,
    createdBy: row.created_by as SkillDefinition['createdBy'],
    version: row.version,
    performanceScore: row.performance_score,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
