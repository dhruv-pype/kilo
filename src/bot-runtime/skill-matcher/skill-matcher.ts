import type { UserMessage } from '../../common/types/message.js';
import type { SkillDefinition } from '../../common/types/skill.js';
import type { SkillMatch, ContextRequirements, ModelPreferences } from '../../common/types/orchestrator.js';
import { fastMatch } from './fast-matcher.js';

/**
 * SkillMatcher — Spec #2 interface implementation.
 *
 * Two-phase matching:
 * 1. Fast path: keyword-based trigger pattern matching (~1ms)
 * 2. Slow path: LLM-based intent classification (~200ms) — only when fast path is uncertain
 *
 * Returns a SkillMatch with:
 * - The matched skill
 * - A confidence score
 * - ContextRequirements (what data to load — drives Spec #4 selective loading)
 * - ModelPreferences (which LLM to use for this skill)
 */

// Fast path is definitive above this threshold — skip slow path
const HIGH_CONFIDENCE_THRESHOLD = 0.7;
// Below this, go to slow path
const LOW_CONFIDENCE_THRESHOLD = 0.4;

export async function matchSkill(
  message: UserMessage,
  skills: SkillDefinition[],
): Promise<SkillMatch | null> {
  if (skills.length === 0) return null;

  // Phase 1: Fast matching
  const fast = fastMatch(message.content, skills);

  if (fast && fast.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
    // High confidence — use directly
    return buildSkillMatch(fast.skill, fast.confidence);
  }

  // Phase 2: LLM-based classification
  // TODO: Implement LLM-based intent classification for ambiguous messages.
  // For now, use the fast match result if it exists (even at lower confidence),
  // or return null to fall through to SkillProposer / general conversation.
  if (fast && fast.confidence >= LOW_CONFIDENCE_THRESHOLD) {
    return buildSkillMatch(fast.skill, fast.confidence);
  }

  return null;
}

function buildSkillMatch(skill: SkillDefinition, confidence: number): SkillMatch {
  return {
    skill,
    confidence,
    contextRequirements: inferContextRequirements(skill),
    modelPreferences: inferModelPreferences(skill),
  };
}

/**
 * Infer what context the Orchestrator needs to load for this skill.
 * This is the key to Spec #4's selective loading — instead of loading
 * everything, we only load what this specific skill needs.
 */
function inferContextRequirements(skill: SkillDefinition): ContextRequirements {
  const hasData = !!skill.dataTable;
  const hasSchedule = !!skill.schedule;
  const hasReadableTables = skill.readableTables.length > 0;

  // Skills that read data need the data. Skills that only write don't.
  const needsSkillData = hasReadableTables || isQueryLikeSkill(skill);

  // Knowledge-based skills need RAG. Data-centric skills don't.
  const needsRAG = skill.behaviorPrompt.toLowerCase().includes('knowledge')
    || skill.behaviorPrompt.toLowerCase().includes('document')
    || skill.behaviorPrompt.toLowerCase().includes('uploaded');

  return {
    needsConversationHistory: true,
    historyDepth: hasSchedule ? 0 : 5,  // Scheduled skills don't need chat history
    needsMemory: !hasData,               // Data skills have their own state; others need memory
    memoryQuery: null,
    needsRAG,
    ragQuery: null,
    needsSkillData: needsSkillData,
    skillDataQuery: null,                // The LLM generates the actual query
  };
}

function inferModelPreferences(skill: SkillDefinition): ModelPreferences {
  // Data analysis and complex queries → stronger model
  if (skill.readableTables.length > 1) {
    return { taskType: 'data_analysis', streaming: true };
  }

  // Skills with schedules are usually simple (reminders, briefings)
  if (skill.schedule) {
    return { taskType: 'simple_qa', streaming: true };
  }

  // Default: standard skill execution
  return { taskType: 'skill_execution', streaming: true };
}

function isQueryLikeSkill(skill: SkillDefinition): boolean {
  const queryKeywords = ['list', 'show', 'what', 'how many', 'summary', 'report', 'insight', 'trend', 'top', 'total'];
  const lower = skill.description.toLowerCase() + ' ' + skill.triggerPatterns.join(' ').toLowerCase();
  return queryKeywords.some((kw) => lower.includes(kw));
}
