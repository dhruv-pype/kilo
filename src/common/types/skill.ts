import type { BotId, SkillId } from './ids.js';

/**
 * Skill Definition Object — Kilo's equivalent of OpenClaw's SKILL.md.
 * This is the central data structure of the entire product.
 *
 * Key changes from the PRD (per Spec #1):
 * - `data_store` REMOVED — replaced by relational tables
 * - `data_table` ADDED — name of this skill's table in the bot's Postgres schema
 * - `readable_tables` ADDED — other skill tables this skill can query
 * - `table_schema` ADDED — the generated DDL (stored for versioning)
 */

export type OutputFormat = 'text' | 'structured_card' | 'notification' | 'action';
export type SkillCreatedBy = 'system' | 'user_conversation' | 'auto_proposed';

export interface SkillDefinition {
  skillId: SkillId;
  botId: BotId;
  name: string;
  description: string;
  triggerPatterns: string[];
  behaviorPrompt: string;
  inputSchema: Record<string, unknown> | null; // JSON Schema draft-07
  outputFormat: OutputFormat;
  schedule: string | null;                      // cron expression
  dataTable: string | null;                     // Postgres table name in bot's schema
  readableTables: string[];                     // tables this skill can SELECT from
  tableSchema: string | null;                   // generated DDL for reference
  requiredIntegrations: string[];
  createdBy: SkillCreatedBy;
  version: number;
  performanceScore: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillCreateInput {
  botId: BotId;
  name: string;
  description: string;
  triggerPatterns: string[];
  behaviorPrompt: string;
  inputSchema: Record<string, unknown> | null;
  outputFormat: OutputFormat;
  schedule: string | null;
  readableTables: string[];
  requiredIntegrations: string[];
  createdBy: SkillCreatedBy;
}
