import type { UserMessage } from '../../common/types/message.js';
import type { SkillDefinition } from '../../common/types/skill.js';
import type { SkillProposal, ToolDefinition } from '../../common/types/orchestrator.js';
import type { LLMGatewayPort } from '../orchestrator/message-orchestrator.js';

/**
 * SkillProposer — Spec #2 interface implementation.
 *
 * Determines when to propose a new skill to the user. This is the
 * "self-building" magic: the bot recognizes a repeatable need and
 * offers to learn how to handle it.
 *
 * Uses a cheap LLM (intent_classification tier) to decide whether to
 * propose and to generate the proposal structure — name, description,
 * trigger examples, optional cron schedule, and clarifying questions.
 *
 * A proposal triggers only when ALL conditions are met:
 * 1. No existing skill matched the message
 * 2. The LLM judges the message as describing a REPEATABLE need
 * 3. The user hasn't dismissed a similar proposal in the last 7 days
 */

export interface ProposalContext {
  recentDismissals: { proposedName: string; dismissedAt: Date }[];
}

// ─── System prompt ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a skill-proposal assistant for a personal AI bot.

Your job: read a user message and decide whether it describes a **repeatable, automatable need** that warrants creating a permanent skill.

## Propose when the message implies:
- A recurring task (daily, weekly, "every morning", "remind me every...")
- Ongoing tracking (expenses, orders, workouts, inventory)
- A template the user will reuse (draft emails, reports, summaries)
- A standing query they'll ask repeatedly (aggregations, reports)
- **Reminder or notification requests** — even one-off ones. If someone asks to be reminded
  of a call, meeting, task, or deadline, propose a Reminder skill. They'll likely want it again.

## Do NOT propose for:
- One-off questions ("what time is it?", "what is the capital of France?")
- General chat ("hello", "thanks")
- Pure mechanical timers with no domain context ("set a timer for 1 hour" — no content to track)
- Factual lookups with no recurring pattern

## Output (JSON tool call — always use the tool):
If the message warrants a skill: call \`propose_skill\` with all fields.
If it does NOT warrant a skill: call \`no_proposal\` with a brief reason.

## Cron schedule format:
Use standard 5-field cron: "minute hour day-of-month month day-of-week"
- "every morning" → "30 6 * * *"
- "every evening" → "0 19 * * *"
- "daily" / "every day" → "0 9 * * *"
- "weekly" / "every week" → "0 9 * * 1"
- "at 8AM" → "0 8 * * *", "at 3PM" → "0 15 * * *"
- "every Monday" → "0 9 * * 1"
Only include schedule if the message specifies timing. Otherwise leave null.

## Name rules:
- 2-4 words, title case
- No time strings ("3PM", "Monday", "daily") in the name
- Bad: "Call Supplier At 3pm Reminder" → Good: "Call Supplier Reminder"

## Data model — choose the right one:
- **notification**: Pure reminder/alert skill. No data table. The skill calls schedule_notification with a computed future time. Use for any "remind me to...", "alert me when...", "notify me at..." pattern. Always set suggestedInputFields to [].
- **per_entry**: Each action creates a new row (workouts, sales, expenses, meals, notes). Use when users will log multiple items per day and each one matters individually.
- **daily_total**: One row per day, updated in-place ("1000 more steps" adds to today's row). Use when the user tracks a running daily aggregate (steps, water intake, screen time).
- **singleton**: A single row that gets overwritten each time (current mood, today's goal, active task). Use for "current state" skills with no history.

## Fields — IMPORTANT rules:
- For **notification** model: always set suggestedInputFields to [] — no table, no fields.
- Do NOT suggest date, time, datetime, or timestamp fields. Every skill table already has a \`logged_at\` column (TIMESTAMPTZ, defaults to now) that handles all time tracking automatically.
- Only suggest fields for the actual domain data (amounts, names, counts, categories, notes, etc.).
- Keep fields minimal — only what's needed to make the skill useful.`;

// ─── Tool definitions ───────────────────────────────────────────

const TOOLS: ToolDefinition[] = [
  {
    name: 'propose_skill',
    description: 'Propose a new skill for the user to approve',
    parameters: {
      type: 'object',
      properties: {
        proposedName: {
          type: 'string',
          description: 'Short descriptive name (2-4 words, title case, no time strings)',
        },
        description: {
          type: 'string',
          description: 'One sentence: what this skill does for the user',
        },
        triggerExamples: {
          type: 'array',
          items: { type: 'string' },
          description: '3-4 example phrases that would trigger this skill',
        },
        suggestedInputFields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['string', 'number', 'boolean', 'date'] },
              description: { type: 'string' },
              required: { type: 'boolean' },
            },
            required: ['name', 'type', 'description', 'required'],
          },
          description: 'Input fields needed when running this skill (empty for scheduled/reminder skills)',
        },
        suggestedSchedule: {
          type: ['string', 'null'],
          description: 'Cron expression if this is a scheduled skill, otherwise null',
        },
        clarifyingQuestions: {
          type: 'array',
          items: { type: 'string' },
          description: '1-2 questions to ask the user before creating the skill',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'How confident (0-1) that this message warrants a skill',
        },
        dataModel: {
          type: 'string',
          enum: ['notification', 'per_entry', 'daily_total', 'singleton'],
          description: 'notification=no table, only schedule_notification (use for reminders/alerts); per_entry=new row each time; daily_total=one row per day updated in-place; singleton=single overwritten row',
        },
      },
      required: [
        'proposedName',
        'description',
        'triggerExamples',
        'suggestedInputFields',
        'suggestedSchedule',
        'clarifyingQuestions',
        'confidence',
        'dataModel',
      ],
    },
  },
  {
    name: 'no_proposal',
    description: 'Indicate this message does not warrant a skill proposal',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Brief reason why no proposal is warranted' },
      },
      required: ['reason'],
    },
  },
];

// ─── Main export ────────────────────────────────────────────────

/**
 * Evaluate whether to propose a new skill based on the user's message.
 * Uses a cheap LLM — runs only on the no-match path.
 */
export async function evaluateForProposal(
  message: UserMessage,
  skills: SkillDefinition[],
  context: ProposalContext,
  llm: LLMGatewayPort,
): Promise<SkillProposal | null> {
  // Check dismissal cooldown first (cheap — no LLM needed)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Call cheap LLM to decide whether to propose
  const llmResponse = await llm.complete(
    {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message.content }],
      tools: TOOLS,
    },
    { taskType: 'intent_classification', streaming: false },
  );

  // Parse the tool call
  const proposal = parseLLMResponse(llmResponse);
  if (!proposal) return null;

  // Check dismissal cooldown against the LLM-generated name
  const recentlyDismissed = context.recentDismissals.some(
    (d) => d.dismissedAt > sevenDaysAgo
      && similarity(d.proposedName, proposal.proposedName) > 0.6,
  );
  if (recentlyDismissed) return null;

  return proposal;
}

// ─── Response parsing ───────────────────────────────────────────

function parseLLMResponse(response: { content: string; toolCalls: { toolName: string; arguments: Record<string, unknown> }[] }): SkillProposal | null {
  const { toolCalls } = response;
  if (!toolCalls || toolCalls.length === 0) return null;

  const call = toolCalls[0];
  if (!call || call.toolName !== 'propose_skill') return null;

  const input = call.arguments;
  if (!input || typeof input !== 'object') return null;

  try {
    return {
      proposedName: String(input.proposedName ?? ''),
      description: String(input.description ?? ''),
      triggerExamples: Array.isArray(input.triggerExamples)
        ? (input.triggerExamples as unknown[]).map(String)
        : [],
      suggestedInputFields: Array.isArray(input.suggestedInputFields)
        ? (input.suggestedInputFields as unknown[]).map((f) => {
            const field = f as Record<string, unknown>;
            return {
              name: String(field.name ?? ''),
              type: String(field.type ?? 'string'),
              description: String(field.description ?? ''),
              required: Boolean(field.required),
            };
          })
        : [],
      suggestedSchedule: input.suggestedSchedule != null ? String(input.suggestedSchedule) : null,
      clarifyingQuestions: Array.isArray(input.clarifyingQuestions)
        ? (input.clarifyingQuestions as unknown[]).map(String)
        : [],
      confidence: typeof input.confidence === 'number'
        ? Math.max(0, Math.min(1, input.confidence))
        : 0.7,
      dataModel: (['notification', 'per_entry', 'daily_total', 'singleton'] as const).includes(input.dataModel as SkillProposal['dataModel'])
        ? (input.dataModel as SkillProposal['dataModel'])
        : 'per_entry',
    };
  } catch {
    return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function similarity(a: string, b: string): number {
  const aTokens = new Set(a.toLowerCase().split(/\s+/));
  const bTokens = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const t of aTokens) {
    if (bTokens.has(t)) intersection++;
  }
  const union = aTokens.size + bTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
