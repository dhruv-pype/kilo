import type { SkillDefinition } from '../../common/types/skill.js';

/**
 * Fast (rule-based) skill matching — Phase 1 of the two-phase matcher.
 *
 * Checks user message against each skill's `triggerPatterns` using
 * keyword overlap. No LLM call — runs in <5ms for typical skill counts.
 *
 * Returns the best match with a confidence score, or null if no
 * pattern matches above the threshold.
 */

const CONFIDENCE_THRESHOLD = 0.4;

export interface FastMatchResult {
  skill: SkillDefinition;
  confidence: number;
  matchedPattern: string;
}

export function fastMatch(
  messageText: string,
  skills: SkillDefinition[],
): FastMatchResult | null {
  const msgTokens = tokenize(messageText);
  let bestMatch: FastMatchResult | null = null;

  for (const skill of skills) {
    if (!skill.isActive) continue;

    for (const pattern of skill.triggerPatterns) {
      const patternTokens = tokenize(pattern);
      const score = computeMatchScore(msgTokens, patternTokens);

      if (score > CONFIDENCE_THRESHOLD && (!bestMatch || score > bestMatch.confidence)) {
        bestMatch = {
          skill,
          confidence: score,
          matchedPattern: pattern,
        };
      }
    }
  }

  return bestMatch;
}

/**
 * Compute a match score between a message and a trigger pattern.
 *
 * Uses a weighted approach:
 * - What percentage of the pattern's keywords appear in the message?
 *   (high weight — the pattern defines the skill's intent)
 * - What percentage of the message's keywords appear in the pattern?
 *   (low weight — messages often have extra context)
 */
function computeMatchScore(msgTokens: Set<string>, patternTokens: Set<string>): number {
  if (patternTokens.size === 0) return 0;

  let patternHits = 0;
  for (const token of patternTokens) {
    if (msgTokens.has(token)) patternHits++;
  }

  // Pattern recall: how much of the pattern was found in the message
  const patternRecall = patternHits / patternTokens.size;

  // Message precision: how much of the message matches the pattern
  let msgHits = 0;
  for (const token of msgTokens) {
    if (patternTokens.has(token)) msgHits++;
  }
  const msgPrecision = msgTokens.size === 0 ? 0 : msgHits / msgTokens.size;

  // Weighted: 70% pattern recall, 30% message precision
  // Pattern recall matters more: "new order" matching "new order for Saturday" is good,
  // even though the message has extra words.
  return patternRecall * 0.7 + msgPrecision * 0.3;
}

// Stop words that add noise to matching
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'it', 'its',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
  'this', 'that', 'these', 'those', 'and', 'but', 'or', 'if', 'then',
  'so', 'up', 'out', 'just', 'also', 'very', 'really', 'please',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t)),
  );
}
