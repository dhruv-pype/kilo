/**
 * Built-in Skill Registry — Phase 3.6
 *
 * Pre-loaded skills that execute locally with zero latency and no API keys.
 * Each built-in skill is a real SkillDefinition that participates in the
 * same fast-matcher pipeline as user-created skills. When matched, the
 * orchestrator short-circuits to the handler instead of calling the LLM.
 *
 * Architecture: types live in types.ts. Handlers import from types.ts.
 * This module imports from handlers — no circular dependencies.
 */

import type { SkillDefinition } from '../../common/types/skill.js';
import { skillId, botId } from '../../common/types/ids.js';
import type { BuiltInHandler, BuiltInSkillConfig } from './types.js';
import { TIME_SKILL_CONFIG, handleTime } from './handlers/time-handler.js';
import { DATE_MATH_SKILL_CONFIG, handleDateMath } from './handlers/date-math-handler.js';
import { RANDOM_SKILL_CONFIG, handleRandom } from './handlers/random-handler.js';

export type { BuiltInHandler, BuiltInSkillConfig } from './types.js';

// ─── Internal registry ──────────────────────────────────────────

const handlerMap = new Map<string, BuiltInHandler>();
const skillDefinitions: SkillDefinition[] = [];
const SYSTEM_BOT_ID = botId('SYSTEM');

function register(id: string, config: BuiltInSkillConfig, handler: BuiltInHandler): void {
  const fullDef: SkillDefinition = {
    ...config,
    skillId: skillId(id),
    botId: SYSTEM_BOT_ID,
    createdBy: 'system',
    version: 1,
    performanceScore: 1.0,
    isActive: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };

  handlerMap.set(id, handler);
  skillDefinitions.push(fullDef);
}

// Register all built-in skills
register('builtin-time', TIME_SKILL_CONFIG, handleTime);
register('builtin-date-math', DATE_MATH_SKILL_CONFIG, handleDateMath);
register('builtin-random', RANDOM_SKILL_CONFIG, handleRandom);

// ─── Public API ──────────────────────────────────────────────────

/**
 * Returns all built-in skill definitions.
 * These get prepended to the user's skills before matching.
 */
export function getBuiltInSkills(): SkillDefinition[] {
  return skillDefinitions;
}

/**
 * Check if a skill is a built-in (system) skill with a registered handler.
 */
export function isBuiltInSkill(skill: SkillDefinition): boolean {
  return skill.createdBy === 'system' && handlerMap.has(skill.skillId as string);
}

/**
 * Get the handler for a built-in skill. Returns null if not found.
 */
export function getBuiltInHandler(id: string): BuiltInHandler | null {
  return handlerMap.get(id) ?? null;
}
