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
