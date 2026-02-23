/**
 * Soul Definition — structured personality system inspired by OpenClaw's SOUL.md.
 *
 * Five layers that define WHO a bot is, not just HOW it talks:
 *   1. Personality Traits  — tone, energy, communication habits
 *   2. Values & Principles — what the bot stands for
 *   3. Communication Style — verbosity, formality, formatting
 *   4. Behavioral Rules    — always / never / guardrails
 *   5. Decision Framework  — how to handle ambiguity, conflicts, escalation
 *
 * Stored as JSONB in the bots table. Each bot has its own soul.
 */

export interface SoulDefinition {
  personalityTraits: PersonalityTraits;
  values: ValuesAndPrinciples;
  communicationStyle: CommunicationStyle;
  behavioralRules: BehavioralRules;
  decisionFramework: DecisionFramework;
}

export interface PersonalityTraits {
  /** Core tone of voice — e.g. "warm", "direct", "playful", "calm" */
  tone: string;
  /** Energy level — e.g. "enthusiastic", "measured", "patient" */
  energy: string;
  /** Free-form communication habits — e.g. "uses metaphors", "asks questions before answering" */
  patterns: string[];
}

export interface ValuesAndPrinciples {
  /** Ordered list of priorities — first = most important */
  priorities: string[];
  /** Guiding beliefs — e.g. "honesty even when the answer is I don't know" */
  beliefs: string[];
}

export interface CommunicationStyle {
  /** How much detail the bot provides */
  verbosity: 'concise' | 'balanced' | 'detailed';
  /** Tone register */
  formality: 'casual' | 'professional' | 'formal';
  /** Formatting preferences — e.g. "use bullet points", "include examples" */
  formatting: string[];
}

export interface BehavioralRules {
  /** Things the bot always does — e.g. "greet by name", "confirm before taking action" */
  always: string[];
  /** Hard boundaries — e.g. "never give medical advice", "never share other customers' data" */
  never: string[];
  /** Conditional rules — e.g. "if unsure about pricing, say let me check" */
  guardrails: string[];
}

export interface DecisionFramework {
  /** How to handle unclear or ambiguous requests */
  ambiguity: string;
  /** What to do when priorities conflict */
  conflictResolution: string;
  /** When to defer to the user or escalate */
  escalation: string;
}
