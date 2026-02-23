import type { SkillCreateInput, SkillDefinition } from '../common/types/skill.js';
import type { ValidationResult } from '../common/types/validation.js';
import { SkillValidationError, SkillLimitExceededError } from '../common/errors/index.js';
import { createSkillTable, dropSkillTable } from './schema-generator.js';
import { validateSkill } from './skill-validator.js';
import * as skillRepo from '../database/repositories/skill-repository.js';
import * as botRepo from '../database/repositories/bot-repository.js';
import { invalidateBotCache } from '../cache/cache-service.js';

/**
 * Skill Creator — high-level service that orchestrates skill creation.
 *
 * This is where Spec #1 (schema generation), Spec #3 (validation),
 * and Spec #4 (cache invalidation) converge.
 *
 * Flow:
 * 1. Check tier limits (free: 5 skills, plus: 25, pro: unlimited)
 * 2. Validate the skill (schema + trigger overlap — Spec #3 stages 1-2)
 * 3. Generate the database table (if skill has data — Spec #1)
 * 4. Persist the skill definition
 * 5. Invalidate the bot's cache (Spec #4)
 * 6. Return the created skill
 *
 * Stage 3 (dry-run) and Stage 4 (user confirmation) from Spec #3
 * are handled at the API/chat layer, not here.
 */

const TIER_LIMITS: Record<string, number> = {
  free: 5,
  plus: 25,
  pro: Infinity,
};

export interface SkillCreationResult {
  skill: SkillDefinition;
  validation: ValidationResult;
  tableCreated: boolean;
}

export async function createSkill(
  input: SkillCreateInput,
  existingSkills: SkillDefinition[],
  userTier: string,
): Promise<SkillCreationResult> {
  // 1. Check tier limits
  const limit = TIER_LIMITS[userTier] ?? TIER_LIMITS.free;
  const currentCount = await skillRepo.countSkillsByBotId(input.botId as string);
  if (currentCount >= limit) {
    throw new SkillLimitExceededError(input.botId as string, limit);
  }

  // 2. Validate (Spec #3 stages 1-2)
  const validation = validateSkill(input, existingSkills);
  if (!validation.passed) {
    throw new SkillValidationError(
      `Skill validation failed at stage: ${validation.stage}`,
      validation.stage,
      validation.errors,
    );
  }

  // 3. Generate database table if skill has structured data
  let dataTable: string | null = null;
  let tableSchema: string | null = null;
  let tableCreated = false;

  if (input.inputSchema && hasProperties(input.inputSchema)) {
    const bot = await botRepo.getBotById(input.botId as string);
    const generated = await createSkillTable(
      bot.schemaName,
      input.name,
      'placeholder', // will be replaced after skill row is created
      input.inputSchema,
    );
    dataTable = generated.shortName;
    tableSchema = generated.ddl;
    tableCreated = true;
  }

  // 4. Persist the skill
  const skill = await skillRepo.createSkill({
    ...input,
    dataTable,
    tableSchema,
  });

  // 5. Invalidate cache so next message picks up the new skill
  await invalidateBotCache(input.botId as string);

  return { skill, validation, tableCreated };
}

/**
 * Delete a skill and its data table.
 */
export async function deleteSkill(
  skillIdValue: string,
  botId: string,
): Promise<void> {
  const skill = await skillRepo.getSkillById(skillIdValue);
  const bot = await botRepo.getBotById(botId);

  // Drop the data table if it exists
  if (skill.dataTable) {
    await dropSkillTable(bot.schemaName, skill.dataTable);
  }

  // Delete the skill row (cascades messages.skill_id to SET NULL)
  await skillRepo.deleteSkill(skillIdValue);

  // Invalidate cache
  await invalidateBotCache(botId);
}

function hasProperties(schema: Record<string, unknown>): boolean {
  const props = schema.properties as Record<string, unknown> | undefined;
  return !!props && Object.keys(props).length > 0;
}
