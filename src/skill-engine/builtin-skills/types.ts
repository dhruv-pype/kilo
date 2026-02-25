/**
 * Types for the built-in skill system.
 * Separated from index.ts to avoid circular imports.
 */

import type { ProcessedResponse } from '../../common/types/orchestrator.js';
import type { SkillDefinition } from '../../common/types/skill.js';

export interface BuiltInHandler {
  (userMessage: string): ProcessedResponse;
}

/** Partial skill definition that handlers export (without system fields). */
export type BuiltInSkillConfig = Omit<
  SkillDefinition,
  'skillId' | 'botId' | 'createdBy' | 'version' | 'performanceScore' | 'isActive' | 'createdAt' | 'updatedAt'
>;
