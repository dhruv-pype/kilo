import type { MemoryFact } from '../../common/types/orchestrator.js';

/**
 * MemoryExtractor — Spec #2 interface implementation.
 *
 * Extracts factual information from user messages for long-term memory.
 * Examples:
 *   "My bakery is called Sweet Crumb" → { key: "bakery_name", value: "Sweet Crumb" }
 *   "We're open 7am to 5pm" → { key: "business_hours", value: "7am to 5pm" }
 *   "I have 5 employees" → { key: "employee_count", value: "5" }
 *
 * This is a rule-based first pass. LLM-based extraction (more accurate,
 * catches subtle preferences) will be added as a side-effect processor
 * that runs async after the response is sent — off the hot path.
 */

interface ExtractionPattern {
  pattern: RegExp;
  keyTemplate: string;
  valueGroup: number;
  source: 'user_stated';
  confidence: number;
}

const EXTRACTION_PATTERNS: ExtractionPattern[] = [
  // Identity: "My name is X", "I'm X"
  {
    pattern: /(?:my\s+name\s+is|i'?m\s+called|they\s+call\s+me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    keyTemplate: 'user_name',
    valueGroup: 1,
    source: 'user_stated',
    confidence: 0.9,
  },
  // Business: "My business/company/bakery/shop is called X"
  {
    pattern: /(?:my|our)\s+(?:business|company|bakery|shop|store|studio|practice|firm|agency)\s+is\s+(?:called\s+)?(.+?)(?:\.|,|\band\b|$)/i,
    keyTemplate: 'business_name',
    valueGroup: 1,
    source: 'user_stated',
    confidence: 0.9,
  },
  // Hours: "We're open X to Y" / "business hours are X"
  {
    pattern: /(?:we'?re|i'?m)\s+open\s+(.+?)(?:\.|$)/i,
    keyTemplate: 'business_hours',
    valueGroup: 1,
    source: 'user_stated',
    confidence: 0.8,
  },
  // Team size: "I have X employees/staff/people"
  {
    pattern: /(?:i|we)\s+have\s+(\d+)\s+(?:employees?|staff|people|team\s+members?|workers?)/i,
    keyTemplate: 'team_size',
    valueGroup: 1,
    source: 'user_stated',
    confidence: 0.8,
  },
  // Location: "I'm based in X" / "We're located in X"
  {
    pattern: /(?:i'?m|we'?re)\s+(?:based|located)\s+in\s+(.+?)(?:\.|,|$)/i,
    keyTemplate: 'location',
    valueGroup: 1,
    source: 'user_stated',
    confidence: 0.8,
  },
  // Preferences: "I prefer X" / "I like X"
  {
    pattern: /i\s+(?:prefer|like|want|always)\s+(.+?)(?:\.|,|$)/i,
    keyTemplate: 'preference',
    valueGroup: 1,
    source: 'user_stated',
    confidence: 0.6,
  },
];

/**
 * Extract memory facts from a user message.
 * Returns an array of facts that should be persisted to the Memory Store.
 */
export function extractMemoryFacts(messageContent: string): MemoryFact[] {
  const facts: MemoryFact[] = [];
  const now = new Date();

  for (const ep of EXTRACTION_PATTERNS) {
    const match = messageContent.match(ep.pattern);
    if (match && match[ep.valueGroup]) {
      const value = match[ep.valueGroup].trim();
      // Skip empty or very long values (likely false positives)
      // Numeric keys (team_size) can be short; text keys need at least 2 chars
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
