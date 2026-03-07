/**
 * Learning Intent Detector — determines if a user message
 * is asking the bot to learn a new integration/API.
 *
 * Pure function (no I/O). Returns the detected service name
 * or null if this is not a learning request.
 *
 * Pattern: runs BEFORE skill matching in the orchestrator.
 */

import type { LearningIntent } from './types.js';
import type { SkillDefinition } from '../common/types/skill.js';

/**
 * Patterns indicating a learning/integration request.
 * Ordered by specificity (most specific first).
 * Each pattern has a capture group for the service name.
 */
const LEARNING_PATTERNS: { pattern: RegExp; confidence: number }[] = [
  // High confidence — explicit learning language
  {
    pattern: /\blearn\s+(?:(?:how\s+)?to\s+)?(?:use|work\s+with|interact\s+with)\s+(?:the\s+)?(.+?)(?:\s+api)?$/i,
    confidence: 0.95,
  },
  {
    pattern: /\bintegrate\s+(?:with\s+)?(?:the\s+)?(.+?)(?:\s+api)?$/i,
    confidence: 0.9,
  },
  {
    pattern: /\badd\s+(?:a\s+)?(?:the\s+)?(.+?)\s+integration$/i,
    confidence: 0.9,
  },

  // Setup patterns
  {
    pattern: /\bset\s+up\s+(?:the\s+)?(.+?)(?:\s+api|\s+integration)?$/i,
    confidence: 0.85,
  },

  // Medium confidence — implied learning (these MUST come before simpler
  // patterns like "connect to X" so "can you connect to X" matches here first)
  {
    pattern: /\bi\s+want\s+you\s+to\s+(?:be\s+able\s+to\s+)?(?:use|access|work\s+with)\s+(?:the\s+)?(.+?)(?:\s+api)?$/i,
    confidence: 0.75,
  },
  {
    pattern: /\bcan\s+you\s+(?:use|access|work\s+with|connect\s+to)\s+(?:the\s+)?(.+?)(?:\s+api)?$/i,
    confidence: 0.7,
  },

  // Generic connect pattern (lower priority — after "can you connect to" above)
  {
    pattern: /\bconnect\s+(?:to\s+)?(?:the\s+)?(.+?)(?:\s+api)?$/i,
    confidence: 0.9,
  },

  // Catch-all — matches any "learn (how) to <something>"
  // Low confidence so it never overrides specific patterns above
  {
    pattern: /\blearn\s+(?:how\s+)?to\s+(.+?)$/i,
    confidence: 0.6,
  },
];

/**
 * Detect whether the user is asking the bot to learn a new API integration.
 *
 * Matches patterns like:
 * - "Learn how to use Canva"
 * - "Integrate with Stripe"
 * - "Connect to the Slack API"
 * - "Add Canva integration"
 * - "I want you to be able to use Trello"
 * - "Set up Notion for me"
 *
 * Returns null if no learning intent is detected.
 */
export function detectLearningIntent(messageText: string): LearningIntent | null {
  const trimmed = messageText.trim();
  if (!trimmed) return null;

  for (const { pattern, confidence } of LEARNING_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      const rawName = match[1].trim();
      if (!rawName || rawName.length > 100) continue;

      const serviceName = cleanServiceName(rawName);
      if (!serviceName) continue;

      return {
        serviceName,
        confidence,
        originalPhrase: trimmed,
      };
    }
  }

  return null;
}

/**
 * Heuristic: does the extracted name look like a service/product name
 * (e.g. "Stripe", "Google Sheets") vs a capability description
 * (e.g. "tell time", "send emails to my team automatically")?
 *
 * Used by the orchestrator to choose between full learning flow
 * and a clarification response.
 */
export function looksLikeServiceName(name: string): boolean {
  // Verb prefixes indicate a capability, not a service name
  const verbPrefixes = /^(tell|send|get|make|create|do|find|show|check|read|write|run|set|build|track|manage|schedule|calculate|convert)\b/i;
  if (verbPrefixes.test(name)) return false;
  if (name.trim().split(/\s+/).length > 4) return false;
  return true;
}

// ─── Clarification Marker ────────────────────────────────────────
// Clarification responses contain this marker so follow-up detection works.
export const CLARIFICATION_MARKER = '<!-- learning-clarification:';

/**
 * Build a marker string to embed in clarification responses.
 * Contains the original capability so follow-up detection can extract it.
 */
export function buildClarificationMarker(capability: string): string {
  return `${CLARIFICATION_MARKER}${capability} -->`;
}

/**
 * Detect if the user is responding affirmatively to a previous learning clarification.
 *
 * Checks:
 * 1. The last assistant message contains a clarification marker
 * 2. The user's message is affirmative ("yes", "sure", "do it", "search for it")
 *    OR contains a service name (e.g., "try WorldTimeAPI")
 *
 * Returns the capability/service name to search for, or null.
 */
export function detectClarificationFollowUp(
  userMessage: string,
  lastAssistantMessage: string | null,
): { searchQuery: string } | null {
  if (!lastAssistantMessage) return null;

  // Check if the last message was a clarification
  const markerIdx = lastAssistantMessage.indexOf(CLARIFICATION_MARKER);
  if (markerIdx === -1) return null;

  // Extract the capability from the marker
  const start = markerIdx + CLARIFICATION_MARKER.length;
  const end = lastAssistantMessage.indexOf(' -->', start);
  if (end === -1) return null;
  const capability = lastAssistantMessage.slice(start, end).trim();
  if (!capability) return null;

  const trimmed = userMessage.trim().toLowerCase();

  // Negative patterns — user declining
  const negative = /^(no|nope|nah|never\s*mind|cancel|stop|forget)\b/i;
  if (negative.test(trimmed)) return null;

  // Check for specific API/service mentions FIRST — more specific than bare affirmatives.
  // e.g., "try the WorldTimeAPI service" should use the user's reply verbatim,
  // not collapse to the generic "{capability} API" from the affirmative branch.
  if (trimmed.length > 0 && trimmed.length < 100) {
    const mentionsApi = /\b(api|service)\b/i.test(trimmed);
    if (mentionsApi) {
      return { searchQuery: userMessage.trim() };
    }
  }

  // Affirmative patterns — user confirming they want to proceed
  const affirmative = /^(yes|yeah|yep|sure|ok|okay|go ahead|do it|please|search|find|look|try|absolutely|definitely|y)\b/i;
  if (affirmative.test(trimmed)) {
    // They said yes. If the original capability contains a known service name,
    // prefer that for better search precision (e.g. "book meetings on my google calendar").
    const inferredService = extractLikelyServiceFromCapability(capability);
    if (inferredService) {
      return { searchQuery: `${inferredService} API` };
    }
    return { searchQuery: `${capability} API` };
  }

  // Short replies that aren't negative are likely service names or instructions to search
  if (trimmed.length > 0 && trimmed.length < 100) {
    if (trimmed.split(/\s+/).length <= 8) {
      return { searchQuery: `${userMessage.trim()} API` };
    }
  }

  return null;
}

// ─── Proposal Marker ──────────────────────────────────────────────────────────
// Skill proposal responses contain this marker so follow-up detection works.
export const PROPOSAL_MARKER = '<!-- skill-proposal:';

/**
 * Build a marker string to embed in skill proposal responses.
 * Contains the proposalId so follow-up detection can look up the DB record.
 */
export function buildProposalMarker(proposalId: string): string {
  return `${PROPOSAL_MARKER}${proposalId} -->`;
}

/**
 * Detect if the user is responding to a previous skill proposal.
 *
 * Checks:
 * 1. The last assistant message contains a proposal marker
 * 2. The user's message is affirmative ("yes", "create", "ok") or negative ("no", "nah")
 *
 * Returns { proposalId, accepted } or null if this isn't a follow-up.
 */
export function detectProposalFollowUp(
  userMessage: string,
  lastAssistantMessage: string | null,
): { proposalId: string; accepted: boolean } | null {
  if (!lastAssistantMessage) return null;

  const markerIdx = lastAssistantMessage.indexOf(PROPOSAL_MARKER);
  if (markerIdx === -1) return null;

  const start = markerIdx + PROPOSAL_MARKER.length;
  const end = lastAssistantMessage.indexOf(' -->', start);
  if (end === -1) return null;
  const proposalId = lastAssistantMessage.slice(start, end).trim();
  if (!proposalId) return null;

  const trimmed = userMessage.trim();

  // Negative patterns — user declining
  const negative = /^(no|nope|nah|never\s*mind|no\s*thanks)\b/i;
  if (negative.test(trimmed)) return { proposalId, accepted: false };

  // Affirmative patterns — user confirming
  const affirmative = /^(yes|yeah|yep|sure|ok|okay|create|go\s*ahead|do\s*it|learn|sounds?\s*good|let'?s\s*(do\s*it|go)|please|absolutely|definitely)\b/i;
  if (affirmative.test(trimmed)) return { proposalId, accepted: true };

  // Don't intercept unrelated replies
  return null;
}

// ─── Skill Exec Marker ────────────────────────────────────────────────────────
// Injected into responses when a user skill runs, so post-execution feedback
// detection can identify which skill produced the response.

export const SKILL_EXEC_MARKER = '<!-- skill-exec:';

export function buildSkillExecMarker(skillId: string): string {
  return `${SKILL_EXEC_MARKER}${skillId} -->`;
}

// ─── Refinement Marker ────────────────────────────────────────────────────────
// Refinement preview responses contain this marker so follow-up detection works.

export const REFINEMENT_MARKER = '<!-- skill-refine:';

export function buildRefinementMarker(refinementId: string): string {
  return `${REFINEMENT_MARKER}${refinementId} -->`;
}

/**
 * Detect if the user is responding to a previous skill refinement preview.
 *
 * Checks:
 * 1. The last assistant message contains a refinement marker
 * 2. The user's message is affirmative ("yes", "apply it") or negative ("no", "no thanks")
 */
export function detectRefinementFollowUp(
  userMessage: string,
  lastAssistantMessage: string | null,
): { refinementId: string; accepted: boolean } | null {
  if (!lastAssistantMessage) return null;

  const markerIdx = lastAssistantMessage.indexOf(REFINEMENT_MARKER);
  if (markerIdx === -1) return null;

  const start = markerIdx + REFINEMENT_MARKER.length;
  const end = lastAssistantMessage.indexOf(' -->', start);
  if (end === -1) return null;
  const refinementId = lastAssistantMessage.slice(start, end).trim();
  if (!refinementId) return null;

  const trimmed = userMessage.trim();

  const negative = /^(no|nope|nah|never\s*mind|no\s*thanks|don'?t|skip)\b/i;
  if (negative.test(trimmed)) return { refinementId, accepted: false };

  const affirmative = /^(yes|yeah|sure|ok|okay|apply|go\s*ahead|do\s*it|looks?\s*good|update\s*it)\b/i;
  if (affirmative.test(trimmed)) return { refinementId, accepted: true };

  return null;
}

/**
 * Detect if the user is giving negative feedback about the last skill execution.
 *
 * Returns non-null only when:
 * 1. The last assistant message contains a skill-exec marker (a skill just ran)
 * 2. The user's message is clearly negative feedback ("that's wrong", "incorrect", etc.)
 */
export function detectPostExecutionFeedback(
  userMessage: string,
  lastAssistantMessage: string | null,
): { skillId: string } | null {
  if (!lastAssistantMessage) return null;

  const markerIdx = lastAssistantMessage.indexOf(SKILL_EXEC_MARKER);
  if (markerIdx === -1) return null;

  const start = markerIdx + SKILL_EXEC_MARKER.length;
  const end = lastAssistantMessage.indexOf(' -->', start);
  if (end === -1) return null;
  const skillId = lastAssistantMessage.slice(start, end).trim();
  if (!skillId) return null;

  const NEGATIVE_PATTERNS = [
    /\bthat'?s?\s*(wrong|incorrect|not right|not what\s*i\s*meant|off)\b/i,
    /\bnot\s*(right|correct|what\s*i\s*(wanted|meant|asked))\b/i,
    /\b(wrong|mistake|incorrect|broken|doesn'?t\s*work|not\s*working)\b/i,
    /\bfix\s*this\b/i,
    /^(no|wrong|nope|incorrect)\b/i,
    /\bthat'?s\s*not\s*(it|right|correct)\b/i,
  ];

  const trimmed = userMessage.trim();
  if (NEGATIVE_PATTERNS.some((p) => p.test(trimmed))) {
    return { skillId };
  }

  return null;
}

/**
 * Detect explicit skill refinement requests like:
 * - "fix my steps skill"
 * - "update the expense tracker to handle retroactive entries"
 * - "improve my steps skill"
 * - "the expense skill doesn't handle weekly totals"
 * - "my steps tracker should support weekly summaries"
 *
 * Uses fuzzy name matching against the skills list.
 * Returns the matching skill and the feedback text, or null.
 */
export function detectSkillRefinementIntent(
  userMessage: string,
  skills: SkillDefinition[],
): { skill: SkillDefinition; feedback: string } | null {
  if (skills.length === 0) return null;

  // Pattern 1: "fix/improve/update/refine [my] X [skill]"
  const EXPLICIT_PATTERNS = [
    /\b(fix|improve|update|refine|change|adjust|modify)\s+(?:my\s+)?(.+?)(?:\s+skill(?:s)?)?\s*(?:to\s+|so\s+that\s+|:.*)?$/i,
    /\b(?:my\s+)?(.+?)\s+skill\s+(isn'?t|doesn'?t|can'?t|won'?t|fails?|doesn'?t\s+handle)\b/i,
    /\bthe\s+(.+?)\s+(?:skill\s+)?should\b/i,
  ];

  for (const pattern of EXPLICIT_PATTERNS) {
    const match = userMessage.match(pattern);
    if (!match) continue;

    // The skill name is in one of the capture groups
    const nameCandidates = match.slice(1).filter(Boolean);
    for (const candidate of nameCandidates) {
      // Skip common non-skill words
      if (/^(it|this|that|the|my|fix|improve|update|refine|change|adjust|isn|doesn|can|won|fail)$/i.test(candidate.trim())) {
        continue;
      }
      const matched = findSkillByName(candidate, skills);
      if (matched) {
        return { skill: matched, feedback: userMessage };
      }
    }
  }

  return null;
}

/**
 * Fuzzy skill name matching — checks if any skill name words appear in the candidate string.
 * Returns the skill with the highest overlap, or null if no match above threshold.
 */
function findSkillByName(candidate: string, skills: SkillDefinition[]): SkillDefinition | null {
  const candidateTokens = tokenizeNameWords(candidate);
  if (candidateTokens.size === 0) return null;

  let bestSkill: SkillDefinition | null = null;
  let bestScore = 0;

  for (const skill of skills) {
    if (!skill.isActive) continue;
    const skillTokens = tokenizeNameWords(skill.name);
    if (skillTokens.size === 0) continue;

    let hits = 0;
    for (const token of skillTokens) {
      if (candidateTokens.has(token)) hits++;
    }

    // Score = fraction of skill name tokens found in candidate
    const score = hits / skillTokens.size;
    if (score > 0.5 && score > bestScore) {
      bestScore = score;
      bestSkill = skill;
    }
  }

  return bestSkill;
}

function tokenizeNameWords(text: string): Set<string> {
  const SKILL_STOP_WORDS = new Set(['skill', 'tracker', 'log', 'manager', 'my', 'the', 'a', 'an']);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !SKILL_STOP_WORDS.has(t)),
  );
}

function extractLikelyServiceFromCapability(capability: string): string | null {
  const lower = capability.toLowerCase();

  const knownServices: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /\bgoogle\s+calendar\b/, name: 'Google Calendar' },
    { pattern: /\bgmail\b/, name: 'Gmail' },
    { pattern: /\bgoogle\s+sheets\b/, name: 'Google Sheets' },
    { pattern: /\bgoogle\s+drive\b/, name: 'Google Drive' },
    { pattern: /\bslack\b/, name: 'Slack' },
    { pattern: /\bnotion\b/, name: 'Notion' },
    { pattern: /\btrello\b/, name: 'Trello' },
    { pattern: /\bstripe\b/, name: 'Stripe' },
    { pattern: /\bgithub\b/, name: 'GitHub' },
    { pattern: /\bcanva\b/, name: 'Canva' },
  ];

  for (const svc of knownServices) {
    if (svc.pattern.test(lower)) return svc.name;
  }

  return null;
}

/**
 * Clean up the extracted service name.
 * Strips trailing "API", "integration", "service" words.
 * Trims whitespace and title-cases.
 */
function cleanServiceName(raw: string): string {
  let cleaned = raw
    .replace(/\s+(api|integration|service|platform|tool)$/i, '')
    .replace(/\s+(api|integration|service|platform|tool)$/i, '') // double-strip for "X API service"
    .trim();

  if (!cleaned) return '';

  // Title-case each word
  cleaned = cleaned
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

  return cleaned;
}
