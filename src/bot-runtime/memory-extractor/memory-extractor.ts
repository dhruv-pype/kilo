import type { MemoryFact, Prompt } from '../../common/types/orchestrator.js';
import type { LLMGatewayPort } from '../orchestrator/message-orchestrator.js';

/**
 * MemoryExtractor — LLM-powered fact extraction with regex fallback.
 *
 * Primary path: Uses gpt-4.1-mini (via 'memory_extraction' task type) to
 * extract structured facts from the conversation. The LLM receives the
 * user message, assistant response, AND existing facts so it can:
 * - Avoid duplicates
 * - Update stale facts with new values
 * - Catch subtle information the regex patterns miss
 *
 * Fallback: If the LLM call fails, falls back to the original regex patterns.
 */

// ─── LLM-powered extraction (primary) ──────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are a fact extraction system. Your job is to extract factual information about the user from a conversation between a user and an AI assistant.

Extract ONLY concrete, factual information. Examples:
- Names, titles, roles
- Business details (name, type, location, hours, team size)
- Preferences and habits
- Important dates, numbers, contacts
- Relationships and associations

Rules:
1. Only extract facts that are clearly stated or strongly implied
2. Use descriptive, snake_case keys (e.g., "user_name", "business_name", "business_hours")
3. Keep values concise but complete
4. Mark source as "user_stated" for facts the user explicitly said, "inferred" for facts you deduced
5. Set confidence between 0.5 and 1.0 (0.9+ for explicit statements, 0.6-0.8 for inferences)
6. Do NOT extract opinions, questions, or temporary states
7. Do NOT re-extract facts that already exist with the same value
8. If a fact updates an existing one, extract it with the new value

NEVER extract these — they are requests or one-off events, not persistent facts about the user:
- Reminder requests ("remind me to...", "wake me up at...", "alert me when...")
- One-time action requests ("log this sale", "send that email", "check the oven")
- Anything time-relative or ephemeral ("in 5 minutes", "tomorrow", "this afternoon")
- What the user wants to DO right now vs. facts about who the user IS

You MUST use the extract_facts tool to return your findings. If there are no facts to extract, call the tool with an empty array.`;

function buildExtractionPrompt(
  userMessage: string,
  assistantResponse: string,
  existingFacts: MemoryFact[],
): Prompt {
  const existingContext = existingFacts.length > 0
    ? `\n\nAlready known facts (do not re-extract unless the value changed):\n${existingFacts.map((f) => `- ${f.key}: ${f.value}`).join('\n')}`
    : '';

  return {
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Extract facts from this conversation turn:${existingContext}

User said: "${userMessage}"

Assistant replied: "${assistantResponse}"

Use the extract_facts tool to return any new or updated facts.`,
      },
    ],
    tools: [
      {
        name: 'extract_facts',
        description: 'Extract factual information from the conversation',
        parameters: {
          type: 'object',
          properties: {
            facts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: {
                    type: 'string',
                    description: 'Snake_case identifier for this fact (e.g., "user_name", "business_hours")',
                  },
                  value: {
                    type: 'string',
                    description: 'The factual value',
                  },
                  source: {
                    type: 'string',
                    enum: ['user_stated', 'inferred'],
                    description: 'How this fact was obtained',
                  },
                  confidence: {
                    type: 'number',
                    minimum: 0.5,
                    maximum: 1.0,
                    description: 'Confidence level (0.9+ explicit, 0.6-0.8 inferred)',
                  },
                },
                required: ['key', 'value', 'source', 'confidence'],
              },
            },
          },
          required: ['facts'],
        },
      },
    ],
  };
}

/**
 * LLM-powered memory extraction (primary path).
 *
 * Calls the LLM with the conversation turn and existing facts.
 * Falls back to regex if the LLM call fails.
 */
export async function extractMemoryFacts(
  userMessage: string,
  assistantResponse: string,
  existingFacts: MemoryFact[],
  llm: LLMGatewayPort,
): Promise<MemoryFact[]> {
  try {
    const prompt = buildExtractionPrompt(userMessage, assistantResponse, existingFacts);
    const response = await llm.complete(prompt, {
      taskType: 'memory_extraction',
      streaming: false,
    });

    // Parse tool call response
    const toolCall = response.toolCalls.find((tc) => tc.toolName === 'extract_facts');
    if (!toolCall) {
      // LLM didn't use the tool — fall back to regex
      return regexExtractMemoryFacts(userMessage);
    }

    const rawFacts = toolCall.arguments.facts as Array<{
      key: string;
      value: string;
      source: string;
      confidence: number;
    }>;

    if (!Array.isArray(rawFacts) || rawFacts.length === 0) {
      return [];
    }

    const now = new Date();
    return rawFacts
      .filter((f) => f.key && f.value && f.key.length > 0 && f.value.length > 0)
      .filter((f) => !isTransientFact(f.key))
      .map((f) => ({
        key: f.key,
        value: f.value,
        source: (f.source === 'user_stated' || f.source === 'inferred' ? f.source : 'inferred') as MemoryFact['source'],
        confidence: Math.max(0.5, Math.min(1.0, f.confidence ?? 0.7)),
        createdAt: now,
      }));
  } catch (err) {
    console.warn('[memory-extractor] LLM extraction failed, falling back to regex:', (err as Error).message);
    return regexExtractMemoryFacts(userMessage);
  }
}

// ─── Transient fact filter ───────────────────────────────────────

const TRANSIENT_KEY_PATTERNS = [
  /reminder/i, /request/i, /alert/i, /notification/i,
  /short_term/i, /one_time/i, /temporary/i, /todo/i, /task/i,
  /appointment/i, /event/i, /schedule/i,
];

/**
 * Returns true if a fact key looks like a one-off event rather than a
 * persistent fact about the user. Used to reject LLM hallucinations like
 * "user_reminder_request_short_term".
 */
function isTransientFact(key: string): boolean {
  return TRANSIENT_KEY_PATTERNS.some((p) => p.test(key));
}

// ─── Regex-based extraction (fallback) ──────────────────────────

interface ExtractionPattern {
  pattern: RegExp;
  keyTemplate: string;
  valueGroup: number;
  source: 'user_stated';
  confidence: number;
}

const EXTRACTION_PATTERNS: ExtractionPattern[] = [
  {
    pattern: /(?:my\s+name\s+is|i'?m\s+called|they\s+call\s+me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    keyTemplate: 'user_name',
    valueGroup: 1,
    source: 'user_stated',
    confidence: 0.9,
  },
  {
    pattern: /(?:my|our)\s+(?:business|company|bakery|shop|store|studio|practice|firm|agency)\s+is\s+(?:called\s+)?(.+?)(?:\.|,|\band\b|$)/i,
    keyTemplate: 'business_name',
    valueGroup: 1,
    source: 'user_stated',
    confidence: 0.9,
  },
  {
    pattern: /(?:we'?re|i'?m)\s+open\s+(.+?)(?:\.|$)/i,
    keyTemplate: 'business_hours',
    valueGroup: 1,
    source: 'user_stated',
    confidence: 0.8,
  },
  {
    pattern: /(?:i|we)\s+have\s+(\d+)\s+(?:employees?|staff|people|team\s+members?|workers?)/i,
    keyTemplate: 'team_size',
    valueGroup: 1,
    source: 'user_stated',
    confidence: 0.8,
  },
  {
    pattern: /(?:i'?m|we'?re)\s+(?:based|located)\s+in\s+(.+?)(?:\.|,|$)/i,
    keyTemplate: 'location',
    valueGroup: 1,
    source: 'user_stated',
    confidence: 0.8,
  },
  {
    pattern: /i\s+(?:prefer|like|want|always)\s+(.+?)(?:\.|,|$)/i,
    keyTemplate: 'preference',
    valueGroup: 1,
    source: 'user_stated',
    confidence: 0.6,
  },
];

/**
 * Regex-based memory extraction (fallback path).
 * Used when LLM extraction fails or is unavailable.
 */
export function regexExtractMemoryFacts(messageContent: string): MemoryFact[] {
  const facts: MemoryFact[] = [];
  const now = new Date();

  for (const ep of EXTRACTION_PATTERNS) {
    const match = messageContent.match(ep.pattern);
    if (match && match[ep.valueGroup]) {
      const value = match[ep.valueGroup].trim();
      const minLength = ep.keyTemplate === 'team_size' ? 1 : 2;
      if (value.length < minLength || value.length > 200) continue;

      facts.push({
        key: ep.keyTemplate,
        value,
        source: ep.source,
        confidence: ep.confidence,
        createdAt: now,
      });
    }
  }

  return facts;
}
