import type { UserMessage, Message } from '../../common/types/message.js';
import type { SkillDefinition } from '../../common/types/skill.js';
import type { SkillProposal } from '../../common/types/orchestrator.js';

/**
 * SkillProposer — Spec #2 interface implementation.
 *
 * Determines when to propose a new skill to the user. This is the
 * "self-building" magic: the bot recognizes a repeatable need and
 * offers to learn how to handle it.
 *
 * A proposal triggers when ALL conditions are met:
 * 1. No existing skill matched the message
 * 2. The message implies a REPEATABLE need (not a one-off question)
 * 3. The user hasn't dismissed a similar proposal recently
 *
 * Conservative by default at launch (Spec #2 decision).
 */

/**
 * Signals that a message describes a repeatable need, not a one-off.
 */
const REPEATABILITY_SIGNALS = {
  // Time-based language → recurring task
  temporal: [
    /every\s+(morning|evening|day|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
    /daily|weekly|monthly/i,
    /remind\s+me\s+(to|about|that)/i,
    /at\s+\d{1,2}(:\d{2})?\s*(am|pm)/i,
    /each\s+(day|week|month|time)/i,
  ],
  // Tracking language → persistent data
  tracking: [
    /keep\s+track\s+of/i,
    /track\s+(my|the|our)/i,
    /log\s+(my|the|this|a)/i,
    /record\s+(my|the|this|a|every)/i,
    /save\s+(this|my|the)/i,
    /add\s+(this|a|new)\s+.*(to|in)\s+(my|the)/i,
  ],
  // Template language → repeating creation
  templating: [
    /draft\s+(a|an|the|me)/i,
    /write\s+(a|an|the|me)/i,
    /create\s+(a|an|the|me).*\s+(for|about)/i,
    /generate\s+(a|an|the|me)/i,
  ],
  // Aggregation language → data analysis over time
  aggregation: [
    /how\s+many/i,
    /which\s+ones/i,
    /summarize/i,
    /summary\s+of/i,
    /total\s+(for|of|this)/i,
    /what('s|\s+is)\s+the\s+(total|average|count)/i,
    /top\s+\d+/i,
    /compare|trend|analysis/i,
  ],
};

export interface ProposalContext {
  recentDismissals: { proposedName: string; dismissedAt: Date }[];
}

/**
 * Evaluate whether to propose a new skill based on the user's message.
 */
export function evaluateForProposal(
  message: UserMessage,
  existingSkills: SkillDefinition[],
  context: ProposalContext,
): SkillProposal | null {
  const text = message.content;

  // Check repeatability signals
  const signals = detectRepeatabilitySignals(text);
  if (signals.length === 0) {
    return null; // One-off question, don't propose
  }

  // Extract what the user wants to do
  const intent = extractIntent(text);
  if (!intent) {
    return null;
  }

  // Check if we recently dismissed a similar proposal (7-day cooldown)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentlyDismissed = context.recentDismissals.some(
    (d) => d.dismissedAt > sevenDaysAgo
      && similarity(d.proposedName, intent.name) > 0.6,
  );
  if (recentlyDismissed) {
    return null;
  }

  return {
    proposedName: intent.name,
    description: intent.description,
    triggerExamples: intent.triggerExamples,
    suggestedInputFields: intent.fields,
    suggestedSchedule: intent.schedule,
    clarifyingQuestions: intent.questions,
    confidence: Math.min(signals.length * 0.3, 0.9), // more signals = higher confidence
  };
}

// ─── Signal Detection ──────────────────────────────────────────

interface Signal {
  category: string;
  pattern: RegExp;
  match: string;
}

function detectRepeatabilitySignals(text: string): Signal[] {
  const signals: Signal[] = [];

  for (const [category, patterns] of Object.entries(REPEATABILITY_SIGNALS)) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        signals.push({ category, pattern, match: match[0] });
        break; // One match per category is enough
      }
    }
  }

  return signals;
}

// ─── Intent Extraction ─────────────────────────────────────────

interface ExtractedIntent {
  name: string;
  description: string;
  triggerExamples: string[];
  fields: { name: string; type: string; description: string; required: boolean }[];
  schedule: string | null;
  questions: string[];
}

/**
 * Basic intent extraction from the message text.
 *
 * This is a rule-based first pass. The full LLM-powered intent extraction
 * will be added when the LLM Gateway is integrated — the LLM can generate
 * much richer skill proposals. This handles the common patterns.
 */
function extractIntent(text: string): ExtractedIntent | null {
  const lower = text.toLowerCase();

  // "keep track of X" / "track my X"
  const trackMatch = lower.match(/(?:keep\s+)?track\s+(?:of\s+)?(?:my\s+)?(.+?)(?:\.|$)/i);
  if (trackMatch) {
    const thing = trackMatch[1].trim();
    return {
      name: `${capitalize(thing)} Tracker`,
      description: `Track and manage your ${thing}`,
      triggerExamples: [`new ${thing}`, `add ${thing}`, `what ${thing} do I have`, `show my ${thing}`],
      fields: [{ name: 'description', type: 'string', description: `Details about the ${thing}`, required: true }],
      schedule: null,
      questions: [`What details should I capture for each ${thing}?`],
    };
  }

  // "remind me to X every Y" / "remind me at 3pm to X"
  // Handle both "remind me to TASK at TIME" and "remind me at TIME to TASK"
  const remindAtTimeFirst = lower.match(/remind\s+me\s+(?:at|on|every)\s+(.+?)\s+to\s+(.+?)$/i);
  const remindTaskFirst = lower.match(/remind\s+me\s+(?:to\s+)?(.+?)\s+(?:every|at|on)\s+(.+?)$/i);
  const remindPlainMatch = lower.match(/remind\s+me\s+(?:to\s+)?(.+?)$/i);

  let remindTask: string | null = null;
  let remindTiming: string | null = null;

  if (remindAtTimeFirst) {
    // "remind me at 3pm to check the oven" → timing=3pm, task=check the oven
    remindTiming = remindAtTimeFirst[1].trim();
    remindTask = remindAtTimeFirst[2].trim();
  } else if (remindTaskFirst) {
    // "remind me to call supplier every monday" → task=call supplier, timing=monday
    remindTask = remindTaskFirst[1].trim();
    remindTiming = remindTaskFirst[2]?.trim() ?? null;
  } else if (remindPlainMatch) {
    // "remind me to call supplier" → task=call supplier, no timing
    remindTask = remindPlainMatch[1].trim();
  }

  if (remindTask) {
    const task = remindTask;
    const timing = remindTiming;
    return {
      name: `${capitalize(task)} Reminder`,
      description: `Remind you to ${task}`,
      triggerExamples: [`remind me to ${task}`, `don't forget ${task}`, `${task} reminder`],
      fields: [],
      schedule: timing ? guessSchedule(timing) : null,
      questions: timing ? [] : ['When should I remind you?'],
    };
  }

  // "every morning/day/week send me X"
  const briefingMatch = lower.match(/every\s+(morning|evening|day|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:send|give|tell)\s+me\s+(.+)/i);
  if (briefingMatch) {
    const frequency = briefingMatch[1];
    const content = briefingMatch[2].trim();
    return {
      name: `${capitalize(frequency)} ${capitalize(content)}`,
      description: `Send you a ${content} every ${frequency}`,
      triggerExamples: [`what's my ${content}`, `show ${content}`, `${frequency} ${content}`],
      fields: [],
      schedule: guessSchedule(frequency),
      questions: [`What should I include in your ${content}?`],
    };
  }

  // "log my X" / "record my X"
  const logMatch = lower.match(/(?:log|record)\s+(?:my\s+)?(.+?)(?:\.|$)/i);
  if (logMatch) {
    const thing = logMatch[1].trim();
    return {
      name: `${capitalize(thing)} Log`,
      description: `Log and track your ${thing}`,
      triggerExamples: [`log ${thing}`, `record ${thing}`, `add ${thing} entry`, `show ${thing} log`],
      fields: [
        { name: 'entry', type: 'string', description: `The ${thing} entry`, required: true },
        { name: 'date', type: 'string', description: 'Date of the entry', required: false },
      ],
      schedule: null,
      questions: [`What information should I capture when you log ${thing}?`],
    };
  }

  // Fallback: if we detected signals but can't extract a clear intent,
  // return null and let the LLM-based proposer handle it later.
  return null;
}

// ─── Helpers ───────────────────────────────────────────────────

function capitalize(str: string): string {
  return str.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

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

function guessSchedule(timing: string): string | null {
  const lower = timing.toLowerCase();
  if (lower.includes('morning')) return '30 6 * * *';   // 6:30 AM
  if (lower.includes('evening')) return '0 19 * * *';    // 7:00 PM
  if (lower.includes('daily') || lower.includes('day')) return '0 9 * * *'; // 9:00 AM
  if (lower.includes('weekly') || lower.includes('week')) return '0 9 * * 1'; // Monday 9 AM
  if (lower.includes('monday')) return '0 9 * * 1';
  if (lower.includes('tuesday')) return '0 9 * * 2';
  if (lower.includes('wednesday')) return '0 9 * * 3';
  if (lower.includes('thursday')) return '0 9 * * 4';
  if (lower.includes('friday')) return '0 9 * * 5';
  if (lower.includes('saturday')) return '0 9 * * 6';
  if (lower.includes('sunday')) return '0 9 * * 0';

  // Try to parse "at 3pm" style
  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2] ?? '0', 10);
    if (timeMatch[3] === 'pm' && hour < 12) hour += 12;
    if (timeMatch[3] === 'am' && hour === 12) hour = 0;
    return `${minute} ${hour} * * *`;
  }

  return null;
}
