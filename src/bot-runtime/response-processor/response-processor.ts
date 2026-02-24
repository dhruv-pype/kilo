import type { SkillDefinition } from '../../common/types/skill.js';
import type { LLMResponse, ProcessedResponse } from '../../common/types/orchestrator.js';
import type { SkillId } from '../../common/types/ids.js';

/**
 * ResponseProcessor — Spec #2 interface implementation.
 *
 * Post-processes LLM responses before sending to the user:
 * 1. Safety filtering (block harmful content)
 * 2. Format validation (ensure output matches skill's output_format)
 * 3. Extract structured data if applicable
 * 4. Generate suggested action chips
 */

const SAFETY_PATTERNS = [
  /\b(kill|harm|hurt)\s+(yourself|themselves|myself)\b/i,
  /medical\s+(diagnosis|prescription|advice)/i,
  /legal\s+advice/i,
  /financial\s+(advice|recommendation).*\b(invest|buy|sell|trade)\b/i,
];

const DISCLAIMERS: Record<string, string> = {
  medical: 'Note: I\'m an AI assistant, not a medical professional. Please consult a doctor for medical advice.',
  legal: 'Note: I\'m an AI assistant, not a lawyer. Please consult a legal professional for legal advice.',
  financial: 'Note: I\'m an AI assistant, not a financial advisor. This is not financial advice.',
};

export function processResponse(
  llmResponse: LLMResponse,
  skill: SkillDefinition | null,
): ProcessedResponse {
  let content = llmResponse.content;
  const skillId = skill?.skillId ?? null;

  // 1. Safety check
  content = applySafetyFilter(content);

  // 2. Add domain disclaimers where appropriate
  content = addDisclaimers(content);

  // 3. Determine format
  const format = skill?.outputFormat === 'structured_card' ? 'structured_card' : 'text';

  // 4. Extract structured data if the skill expects it
  let structuredData: Record<string, unknown> | null = null;
  if (format === 'structured_card') {
    structuredData = tryExtractStructuredData(content);
  }

  // 5. Generate suggested actions
  const suggestedActions = generateSuggestedActions(content, skill);

  return {
    content,
    format,
    structuredData,
    skillId: skillId as SkillId | null,
    suggestedActions,
    thinkingSummary: llmResponse.thinkingSummary,
  };
}

function applySafetyFilter(content: string): string {
  for (const pattern of SAFETY_PATTERNS) {
    if (pattern.test(content)) {
      return 'I\'m not able to help with that kind of request. Is there something else I can assist you with?';
    }
  }
  return content;
}

function addDisclaimers(content: string): string {
  const lower = content.toLowerCase();
  const parts = [content];

  if (lower.includes('diagnos') || lower.includes('symptom') || lower.includes('medication')) {
    parts.push('\n\n' + DISCLAIMERS.medical);
  }
  if (lower.includes('lawsuit') || lower.includes('legal right') || lower.includes('sue ')) {
    parts.push('\n\n' + DISCLAIMERS.legal);
  }
  if (lower.includes('invest') || lower.includes('stock') || lower.includes('portfolio')) {
    parts.push('\n\n' + DISCLAIMERS.financial);
  }

  return parts.join('');
}

function tryExtractStructuredData(content: string): Record<string, unknown> | null {
  // Try to find JSON in the response
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function generateSuggestedActions(content: string, skill: SkillDefinition | null): string[] {
  const actions: string[] = [];

  if (!skill) {
    return actions;
  }

  // Suggest follow-up actions based on the skill type
  if (skill.dataTable) {
    actions.push(`Show all ${skill.name.toLowerCase().replace(' tracker', '').replace(' log', '')}s`);
  }

  if (skill.schedule) {
    actions.push('Change notification schedule');
  }

  // Cap at 3 suggestions to avoid UI clutter
  return actions.slice(0, 3);
}
