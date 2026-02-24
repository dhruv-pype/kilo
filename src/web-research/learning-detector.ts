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
