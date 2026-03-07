/**
 * SkillGenerator — LLM-powered skill prompt generation and refinement.
 *
 * Replaces the static `buildBehaviorPrompt` template with a domain-aware
 * LLM call that produces behavior prompts with:
 * - WHY explanations (not just rules)
 * - Worked examples covering the full interaction
 * - Data model implications spelled out
 * - Real column names from the table DDL
 * - 8-12 optimized trigger patterns
 */

import type {
  SkillProposal,
  SkillGenerationResult,
  SkillRefinementResult,
  Prompt,
  LLMResponse,
} from '../common/types/orchestrator.js';
import type { SkillDefinition } from '../common/types/skill.js';

/** Minimal port — structurally compatible with the real LLMGatewayPort. */
interface LLMPort {
  complete(prompt: Prompt, options: { taskType: string; streaming: boolean }): Promise<LLMResponse>;
}

// ─── Tool definition ────────────────────────────────────────────

const GENERATE_SKILL_SPEC_TOOL = {
  name: 'generate_skill_spec',
  description: 'Output the complete skill specification. MUST be called exactly once.',
  parameters: {
    type: 'object',
    required: ['behaviorPrompt', 'triggerPatterns', 'description', 'needsHistory', 'needsMemory', 'readsData'],
    properties: {
      behaviorPrompt: {
        type: 'string',
        description: 'The full behavior prompt for the executing model. Must include WHY explanations and worked examples.',
      },
      triggerPatterns: {
        type: 'array',
        items: { type: 'string' },
        minItems: 8,
        description: '8-12 trigger phrases covering paraphrases, short/long forms, and domain vocabulary.',
      },
      description: {
        type: 'string',
        description: 'Concise skill description with "Use when..." guidance to help the skill matcher.',
      },
      needsHistory: {
        type: 'boolean',
        description: 'Whether the executing model needs recent conversation history.',
      },
      needsMemory: {
        type: 'boolean',
        description: 'Whether the executing model needs user memory facts.',
      },
      readsData: {
        type: 'boolean',
        description: 'Whether the skill needs to pre-load a data snapshot before responding.',
      },
    },
  },
};

const REFINE_SKILL_SPEC_TOOL = {
  ...GENERATE_SKILL_SPEC_TOOL,
  parameters: {
    ...GENERATE_SKILL_SPEC_TOOL.parameters,
    required: [...GENERATE_SKILL_SPEC_TOOL.parameters.required, 'changesSummary'],
    properties: {
      ...GENERATE_SKILL_SPEC_TOOL.parameters.properties,
      changesSummary: {
        type: 'string',
        description: 'Bullet list (markdown) of what changed and why. Shown directly to the user.',
      },
    },
  },
};

// ─── System prompt helpers ──────────────────────────────────────

const CORE_PRINCIPLES = `
CORE PRINCIPLES FOR BEHAVIOR PROMPTS:

1. EXPLAIN WHY, NOT JUST WHAT
   Don't write rules. Explain the reasoning so the model can generalize.
   Bad:  "MUST check for existing entry before inserting"
   Good: "Because this skill tracks a daily total (one entry per day), you need to check
          whether an entry already exists for the target date — if you skip this check,
          you'd create a duplicate row instead of updating the running total."

2. WORKED EXAMPLES ARE REQUIRED
   Include 3-4 concrete interaction examples in this format:
   User: "[phrase]" → tool_call({args}) → Reply: "[confirmation text]"
   Cover: new entry, additive/retroactive update, query, missing required field.

3. DATE HANDLING — NEVER HARDCODE CURRENT_DATE
   When the user says "yesterday" → compute CURRENT_DATE - 1
   When the user says "March 1st" → '2026-03-01'
   When the user says "this morning" → today's date
   Always determine the TARGET DATE from the message, then use that date for both
   the existence check and the write operation.

4. USE REAL COLUMN NAMES
   Reference the actual column names from the table DDL provided. Never use
   placeholder names like {table} or {column}.

5. TRIGGER PATTERNS: 8-12 PHRASES
   Cover: short forms, long forms, paraphrases, domain vocabulary, indirect references.
   All tokens in each pattern must be meaningful (the matcher requires all-tokens-present).
   Avoid patterns with stop words as the only content.

6. DESCRIPTION: BE SPECIFIC AND PUSHY
   Include "Use when..." language so the skill matcher triggers it appropriately.
   Kilo tends to undertrigger — err on the side of being more inclusive.

7. TIMESTAMP VALUES — NEVER USE SQL EXPRESSIONS
   The current date/time is injected into every skill prompt as "Current date/time: ISO_STRING".
   The executing model must use that value to compute future timestamps.
   - "in 2 minutes" → add 2 minutes to the injected current time, output ISO 8601 string
   - "at 3pm" → combine today's date with 15:00, output ISO 8601 string
   NEVER instruct the model to pass SQL expressions (CURRENT_TIMESTAMP, NOW(),
   CURRENT_TIMESTAMP + INTERVAL '2 minutes') as values to insert_skill_data or update_skill_data.
   Always pass concrete ISO 8601 strings (e.g., "2026-03-07T22:14:00.000Z").
   For future reminders, use the schedule_notification tool — NOT insert_skill_data.
`.trim();

// ─── Public API ─────────────────────────────────────────────────

/**
 * Generate a complete skill specification from a proposal.
 * Uses `skill_generation` task type (Sonnet + 5k thinking budget).
 *
 * @param proposal - The SkillProposal from the skill-proposer
 * @param tableSchema - Actual DDL string (so LLM knows real column names), or null
 * @param llm - LLM gateway port
 */
export async function generate(
  proposal: SkillProposal,
  tableSchema: string | null,
  llm: LLMPort,
): Promise<SkillGenerationResult> {
  const dataModelExplanation = describeDataModel(proposal.dataModel);
  const fieldList = proposal.suggestedInputFields
    .map((f) => `  - ${f.name} (${f.type}${f.required ? ', required' : ', optional'}): ${f.description}`)
    .join('\n');

  const schemaSection = tableSchema
    ? `\n## Table DDL (use these exact column names)\n\`\`\`sql\n${tableSchema}\n\`\`\``
    : proposal.suggestedInputFields.length > 0
      ? `\n## Expected columns\n${fieldList}\n(Table will be created from these fields)`
      : '';

  const systemPrompt = `You are writing a behavior prompt for a personal AI assistant skill.

${CORE_PRINCIPLES}

Call generate_skill_spec exactly once with the complete specification.`;

  const userMessage = `Create the skill specification for:

## Skill: ${proposal.proposedName}
**Intent**: ${proposal.description}
**Data model**: ${dataModelExplanation}
${schemaSection}

**User-facing trigger examples** (from the user who requested this skill):
${proposal.triggerExamples.map((e) => `  - "${e}"`).join('\n')}

Write a behavior prompt that:
- Explains WHY each decision matters (not just rules)
- Includes 3-4 worked examples covering new entry, update, query, and missing field
- Spells out date calculation logic (never hardcode CURRENT_DATE — always derive target date from user message)
- References real column names${tableSchema ? ' from the DDL above' : ''}
- Handles "X more" / additive updates correctly for ${proposal.dataModel} model

Also write 8-12 trigger patterns that cover all natural ways a user would invoke this skill.
Optimize for the fast keyword matcher (all tokens must appear in the message).`;

  const prompt: Prompt = {
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    tools: [GENERATE_SKILL_SPEC_TOOL],
  };

  const response = await llm.complete(prompt, { taskType: 'skill_generation', streaming: false });

  return extractGenerationResult(response, 'generate');
}

/**
 * Refine an existing skill based on user feedback.
 * Builds on the existing spec rather than starting from scratch.
 *
 * @param skill - The current SkillDefinition to refine
 * @param feedback - User's feedback text
 * @param conversationContext - Last 3-5 messages as plain text
 * @param llm - LLM gateway port
 */
export async function refine(
  skill: SkillDefinition,
  feedback: string,
  conversationContext: string,
  llm: LLMPort,
): Promise<SkillRefinementResult> {
  const systemPrompt = `You are improving an existing behavior prompt for a personal AI assistant skill.

${CORE_PRINCIPLES}

You will be given:
- The current behavior prompt
- The current trigger patterns
- User feedback describing what needs to change
- Recent conversation context showing what went wrong

Your job is to produce an IMPROVED version that addresses the feedback while preserving what works.
Call generate_skill_spec exactly once with the improved specification.`;

  const userMessage = `## Skill: ${skill.name}
**Description**: ${skill.description}

## Current behavior prompt
\`\`\`
${skill.behaviorPrompt}
\`\`\`

## Current trigger patterns
${skill.triggerPatterns.map((p) => `  - "${p}"`).join('\n')}

## User feedback
${feedback}

## Recent conversation context
\`\`\`
${conversationContext}
\`\`\`

Produce an improved specification that:
1. Directly addresses the feedback
2. Preserves what was working before
3. Includes the same worked examples structure, updated to reflect the fix
4. Lists what changed and why in changesSummary (bullet points, shown to user)`;

  const prompt: Prompt = {
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    tools: [REFINE_SKILL_SPEC_TOOL],
  };

  const response = await llm.complete(prompt, { taskType: 'skill_generation', streaming: false });

  return extractRefinementResult(response);
}

// ─── Extraction helpers ──────────────────────────────────────────

function extractGenerationResult(response: LLMResponse, caller: 'generate' | 'refine'): SkillGenerationResult {
  const toolCall = response.toolCalls.find((t) => t.toolName === 'generate_skill_spec');
  if (!toolCall) {
    throw new Error(`[skill-generator] ${caller}(): LLM did not call generate_skill_spec`);
  }

  const args = toolCall.arguments as Record<string, unknown>;

  return {
    behaviorPrompt: String(args.behaviorPrompt ?? ''),
    triggerPatterns: (args.triggerPatterns as string[] | undefined) ?? [],
    description: String(args.description ?? ''),
    needsHistory: Boolean(args.needsHistory ?? true),
    needsMemory: Boolean(args.needsMemory ?? false),
    readsData: Boolean(args.readsData ?? false),
  };
}

function extractRefinementResult(response: LLMResponse): SkillRefinementResult {
  const base = extractGenerationResult(response, 'refine');
  const toolCall = response.toolCalls.find((t) => t.toolName === 'generate_skill_spec');
  const args = (toolCall?.arguments ?? {}) as Record<string, unknown>;

  return {
    ...base,
    changesSummary: String(args.changesSummary ?? ''),
  };
}

// ─── Data model helpers ─────────────────────────────────────────

function describeDataModel(model: SkillProposal['dataModel']): string {
  switch (model) {
    case 'notification':
      return 'notification — NO data table. This skill ONLY calls schedule_notification. Extract the reminder message and compute the target time as an ISO 8601 string from the current date/time injected in the system prompt. Never call insert_skill_data or update_skill_data.';
    case 'daily_total':
      return 'daily_total — one row per day, updated in-place when user logs more. Use check-then-insert-or-update pattern. Never create duplicate rows for the same day.';
    case 'singleton':
      return 'singleton — exactly one row always, overwritten when user updates. Use check-then-insert-or-update pattern.';
    case 'per_entry':
      return 'per_entry — new row for every logged event. Always insert, never update existing rows (unless user explicitly asks to correct a specific entry).';
  }
}
