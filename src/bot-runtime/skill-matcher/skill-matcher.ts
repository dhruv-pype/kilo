import type { UserMessage } from '../../common/types/message.js';
import type { SkillDefinition } from '../../common/types/skill.js';
import type { SkillMatch, ContextRequirements, ModelPreferences, Prompt } from '../../common/types/orchestrator.js';
import type { LLMGatewayPort } from '../orchestrator/message-orchestrator.js';
import { fastMatch } from './fast-matcher.js';

/**
 * SkillMatcher — Two-phase matching with LLM slow path.
 *
 * 1. Fast path: keyword-based trigger pattern matching (~1ms)
 * 2. Slow path: LLM-based intent classification (~200ms) — only when fast path is uncertain
 *
 * The LLM parameter is optional for backward compatibility — when not provided,
 * the matcher falls back to fast-only matching (original behavior).
 */

// Fast path is definitive above this threshold — skip slow path
const HIGH_CONFIDENCE_THRESHOLD = 0.7;
// Below this, go to slow path
const LOW_CONFIDENCE_THRESHOLD = 0.4;

export async function matchSkill(
  message: UserMessage,
  skills: SkillDefinition[],
  llm?: LLMGatewayPort,
): Promise<SkillMatch | null> {
  if (skills.length === 0) return null;

  // Phase 1: Fast matching
  const fast = fastMatch(message.content, skills);

  if (fast && fast.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
    // High confidence — use directly
    return buildSkillMatch(fast.skill, fast.confidence);
  }

  // Phase 2: LLM-based classification (when available)
  if (llm) {
    try {
      const llmResult = await llmClassifyIntent(message.content, skills, llm);
      if (llmResult) {
        return buildSkillMatch(llmResult.skill, llmResult.confidence);
      }
    } catch (err) {
      console.warn('[skill-matcher] LLM classification failed, using fast match fallback:', (err as Error).message);
    }
  }

  // Fallback: use fast match result if it exists at lower confidence
  if (fast && fast.confidence >= LOW_CONFIDENCE_THRESHOLD) {
    return buildSkillMatch(fast.skill, fast.confidence);
  }

  return null;
}

// ─── LLM-based intent classification ────────────────────────────

/**
 * Use a cheap LLM to classify the user's intent against available skills.
 * Returns the matched skill + confidence, or null if no match.
 */
async function llmClassifyIntent(
  messageContent: string,
  skills: SkillDefinition[],
  llm: LLMGatewayPort,
): Promise<{ skill: SkillDefinition; confidence: number } | null> {
  // Build a compact skill catalog for the LLM
  const catalog = skills.map((s, i) => ({
    index: i,
    name: s.name,
    description: s.description,
    triggers: s.triggerPatterns.slice(0, 3),
  }));

  const prompt: Prompt = {
    system: `You are an intent classifier. Given a user message and a list of available skills, determine which skill (if any) the user is trying to invoke.

Rules:
1. Match based on INTENT, not just keywords. "I need to place an order" matches an ordering skill even if "order" isn't a trigger word.
2. If no skill clearly matches, return skill_name "none".
3. Be conservative — only match if you're reasonably confident the user wants that skill's functionality.
4. Built-in skills like "time", "date-math", "random" handle their specific domains.

You MUST use the classify_intent tool to return your classification.`,
    messages: [
      {
        role: 'user',
        content: `Classify this user message:
"${messageContent}"

Available skills:
${catalog.map((s) => `- ${s.name}: ${s.description} (triggers: ${s.triggers.join(', ')})`).join('\n')}

Use the classify_intent tool to return the best match.`,
      },
    ],
    tools: [
      {
        name: 'classify_intent',
        description: 'Classify the user intent against available skills',
        parameters: {
          type: 'object',
          properties: {
            skill_name: {
              type: 'string',
              description: 'Name of the matched skill, or "none" if no match',
            },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'Confidence in the match (0-1)',
            },
            reasoning: {
              type: 'string',
              description: 'Brief explanation of why this skill was matched (or not)',
            },
          },
          required: ['skill_name', 'confidence', 'reasoning'],
        },
      },
    ],
  };

  const response = await llm.complete(prompt, {
    taskType: 'intent_classification',
    streaming: false,
  });

  const toolCall = response.toolCalls.find((tc) => tc.toolName === 'classify_intent');
  if (!toolCall) return null;

  const skillName = toolCall.arguments.skill_name as string;
  const confidence = toolCall.arguments.confidence as number;

  if (!skillName || skillName === 'none' || confidence < 0.5) {
    return null;
  }

  // Exact match first, then fuzzy fallback for paraphrased names
  const matchedSkill = skills.find(
    (s) => s.name.toLowerCase() === skillName.toLowerCase(),
  ) ?? skills
    .map((s) => ({ skill: s, score: nameSimilarity(s.name, skillName) }))
    .filter((r) => r.score >= 0.5)
    .sort((a, b) => b.score - a.score)[0]?.skill;

  if (!matchedSkill) return null;

  return { skill: matchedSkill, confidence: Math.max(0.5, Math.min(1.0, confidence)) };
}

// ─── Shared helpers (unchanged) ─────────────────────────────────

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
  const hasReadableTables = skill.readableTables.length > 0;
  const needsSkillData = skill.readsData || hasReadableTables;

  const needsRAG = skill.behaviorPrompt.toLowerCase().includes('knowledge')
    || skill.behaviorPrompt.toLowerCase().includes('document')
    || skill.behaviorPrompt.toLowerCase().includes('uploaded');

  return {
    needsConversationHistory: skill.needsHistory,
    historyDepth: skill.needsHistory ? 5 : 0,
    needsMemory: skill.needsMemory,
    memoryQuery: null,
    needsRAG,
    ragQuery: null,
    needsSkillData,
    skillDataQuery: null,
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

function nameSimilarity(a: string, b: string): number {
  const aTokens = new Set(a.toLowerCase().split(/\s+/));
  const bTokens = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const t of aTokens) {
    if (bTokens.has(t)) intersection++;
  }
  const union = aTokens.size + bTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
