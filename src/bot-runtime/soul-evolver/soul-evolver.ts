import type { Prompt, SoulPatch } from '../../common/types/orchestrator.js';
import type { SoulDefinition } from '../../common/types/soul.js';
import type { LLMGatewayPort } from '../orchestrator/message-orchestrator.js';

/**
 * Soul Evolver — detects explicit personality instructions and applies patches.
 *
 * Two functions:
 * 1. extractSoulUpdates() — LLM-powered detection of personality change requests
 * 2. applySoulPatches()   — Pure function that applies patches to a SoulDefinition
 *
 * CONSERVATIVE by design: only acts on EXPLICIT instructions like:
 * - "Be more concise"
 * - "Never give medical advice"
 * - "Always call me Boss"
 * - "Use a more formal tone"
 *
 * Does NOT evolve the soul based on inferred preferences — that would be creepy.
 */

// ─── Valid paths for soul patches ───────────────────────────────

const VALID_SCALAR_PATHS = new Set([
  'personalityTraits.tone',
  'personalityTraits.energy',
  'communicationStyle.verbosity',
  'communicationStyle.formality',
  'decisionFramework.ambiguity',
  'decisionFramework.conflictResolution',
  'decisionFramework.escalation',
]);

const VALID_ARRAY_PATHS = new Set([
  'personalityTraits.patterns',
  'values.priorities',
  'values.beliefs',
  'communicationStyle.formatting',
  'behavioralRules.always',
  'behavioralRules.never',
  'behavioralRules.guardrails',
]);

// ─── LLM-powered soul update detection ──────────────────────────

const SOUL_SYSTEM_PROMPT = `You are a personality evolution detector. Your job is to detect when a user EXPLICITLY instructs their AI assistant to change its behavior, personality, or communication style.

You MUST be very conservative. Only detect changes when the user gives a CLEAR, DIRECT instruction. Examples:
- "Be more concise" → set communicationStyle.verbosity = "concise"
- "Never give medical advice" → add behavioralRules.never = "give medical advice"
- "Always call me Boss" → add behavioralRules.always = "address the user as Boss"
- "Use a friendlier tone" → set personalityTraits.tone = "friendly"
- "Be more formal" → set communicationStyle.formality = "formal"
- "Stop using bullet points" → remove communicationStyle.formatting = "use bullet points"

DO NOT detect changes for:
- Casual conversation ("I prefer vanilla ice cream" is NOT a personality change)
- Questions ("Can you be more concise?" needs context — only if clearly a directive)
- Implicit preferences (if user seems to like short answers, don't change anything)

Valid paths for 'set' operations (scalar values):
- personalityTraits.tone (string: tone of voice)
- personalityTraits.energy (string: energy level)
- communicationStyle.verbosity (must be: "concise", "balanced", or "detailed")
- communicationStyle.formality (must be: "casual", "professional", or "formal")
- decisionFramework.ambiguity (string: how to handle ambiguity)
- decisionFramework.conflictResolution (string: conflict resolution approach)
- decisionFramework.escalation (string: escalation approach)

Valid paths for 'add'/'remove' operations (array values):
- personalityTraits.patterns (communication habits)
- values.priorities (ordered priorities)
- values.beliefs (guiding beliefs)
- communicationStyle.formatting (formatting preferences)
- behavioralRules.always (always-do rules)
- behavioralRules.never (never-do rules)
- behavioralRules.guardrails (conditional rules)

Use the soul_updates tool. If there are no personality changes, call it with an empty patches array.`;

function buildSoulPrompt(
  userMessage: string,
  assistantResponse: string,
  currentSoul: SoulDefinition,
): Prompt {
  const soulSummary = [
    `Current personality: tone="${currentSoul.personalityTraits.tone}", energy="${currentSoul.personalityTraits.energy}"`,
    `Communication: verbosity="${currentSoul.communicationStyle.verbosity}", formality="${currentSoul.communicationStyle.formality}"`,
    `Always: ${currentSoul.behavioralRules.always.join(', ') || '(none)'}`,
    `Never: ${currentSoul.behavioralRules.never.join(', ') || '(none)'}`,
  ].join('\n');

  return {
    system: SOUL_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Detect any explicit personality change instructions in this conversation turn.

Current soul configuration:
${soulSummary}

User said: "${userMessage}"

Assistant replied: "${assistantResponse}"

Use the soul_updates tool to return any detected changes.`,
      },
    ],
    tools: [
      {
        name: 'soul_updates',
        description: 'Report detected personality/behavior change instructions',
        parameters: {
          type: 'object',
          properties: {
            patches: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: {
                    type: 'string',
                    description: 'Dot-notation path in the soul definition (e.g., "communicationStyle.verbosity")',
                  },
                  operation: {
                    type: 'string',
                    enum: ['set', 'add', 'remove'],
                    description: 'set for scalar values, add/remove for array values',
                  },
                  value: {
                    type: 'string',
                    description: 'The new value to set, or the item to add/remove',
                  },
                },
                required: ['path', 'operation', 'value'],
              },
            },
          },
          required: ['patches'],
        },
      },
    ],
  };
}

/**
 * Detect explicit personality change instructions using LLM.
 * Returns patches to apply to the soul definition.
 */
export async function extractSoulUpdates(
  userMessage: string,
  assistantResponse: string,
  currentSoul: SoulDefinition,
  llm: LLMGatewayPort,
): Promise<SoulPatch[]> {
  try {
    const prompt = buildSoulPrompt(userMessage, assistantResponse, currentSoul);
    const response = await llm.complete(prompt, {
      taskType: 'soul_extraction',
      streaming: false,
    });

    const toolCall = response.toolCalls.find((tc) => tc.toolName === 'soul_updates');
    if (!toolCall) return [];

    const rawPatches = toolCall.arguments.patches as Array<{
      path: string;
      operation: string;
      value: string;
    }>;

    if (!Array.isArray(rawPatches) || rawPatches.length === 0) {
      return [];
    }

    // Validate and filter patches
    return rawPatches.filter((p) => {
      if (!p.path || !p.operation || !p.value) return false;

      const op = p.operation as SoulPatch['operation'];
      if (op === 'set') {
        return VALID_SCALAR_PATHS.has(p.path);
      } else if (op === 'add' || op === 'remove') {
        return VALID_ARRAY_PATHS.has(p.path);
      }
      return false;
    }).map((p) => ({
      path: p.path,
      operation: p.operation as SoulPatch['operation'],
      value: p.value,
    }));
  } catch (err) {
    console.warn('[soul-evolver] LLM extraction failed:', (err as Error).message);
    return [];
  }
}

// ─── Pure function: apply patches to a soul ─────────────────────

/**
 * Apply soul patches to a SoulDefinition.
 * Pure function — deep clones the input, applies each patch, returns the result.
 * Invalid paths are silently skipped.
 */
export function applySoulPatches(
  soul: SoulDefinition,
  patches: SoulPatch[],
): SoulDefinition {
  // Deep clone to avoid mutating the original
  const result = JSON.parse(JSON.stringify(soul)) as SoulDefinition;

  for (const patch of patches) {
    const parts = patch.path.split('.');
    if (parts.length !== 2) continue;

    const [section, field] = parts;

    // Navigate to the section
    const sectionObj = (result as unknown as Record<string, Record<string, unknown>>)[section];
    if (!sectionObj || typeof sectionObj !== 'object') continue;

    const currentValue = sectionObj[field];

    switch (patch.operation) {
      case 'set': {
        if (!VALID_SCALAR_PATHS.has(patch.path)) break;
        // Validate enum values for constrained fields
        if (field === 'verbosity' && !['concise', 'balanced', 'detailed'].includes(patch.value)) break;
        if (field === 'formality' && !['casual', 'professional', 'formal'].includes(patch.value)) break;
        sectionObj[field] = patch.value;
        break;
      }
      case 'add': {
        if (!VALID_ARRAY_PATHS.has(patch.path)) break;
        if (!Array.isArray(currentValue)) break;
        // Don't add duplicates
        if (!currentValue.includes(patch.value)) {
          currentValue.push(patch.value);
        }
        break;
      }
      case 'remove': {
        if (!VALID_ARRAY_PATHS.has(patch.path)) break;
        if (!Array.isArray(currentValue)) break;
        const idx = currentValue.indexOf(patch.value);
        if (idx !== -1) {
          currentValue.splice(idx, 1);
        }
        break;
      }
    }
  }

  return result;
}
