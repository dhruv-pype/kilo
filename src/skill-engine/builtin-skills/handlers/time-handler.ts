/**
 * Built-in Time & Date handler — Phase 3.6
 *
 * Handles: "what time is it", "current time in Tokyo", "what's today's date"
 * Uses Intl.DateTimeFormat for locale-aware formatting — no external deps.
 */

import type { ProcessedResponse } from '../../../common/types/orchestrator.js';
import type { SkillId } from '../../../common/types/ids.js';
import type { BuiltInSkillConfig } from '../types.js';

// ─── City → IANA timezone mapping (top ~40 cities) ──────────────

const CITY_TIMEZONE_MAP: Record<string, string> = {
  // Americas
  'new york': 'America/New_York',
  'nyc': 'America/New_York',
  'los angeles': 'America/Los_Angeles',
  'la': 'America/Los_Angeles',
  'chicago': 'America/Chicago',
  'denver': 'America/Denver',
  'san francisco': 'America/Los_Angeles',
  'seattle': 'America/Los_Angeles',
  'miami': 'America/New_York',
  'toronto': 'America/Toronto',
  'vancouver': 'America/Vancouver',
  'mexico city': 'America/Mexico_City',
  'sao paulo': 'America/Sao_Paulo',
  'buenos aires': 'America/Argentina/Buenos_Aires',

  // Europe
  'london': 'Europe/London',
  'paris': 'Europe/Paris',
  'berlin': 'Europe/Berlin',
  'rome': 'Europe/Rome',
  'madrid': 'Europe/Madrid',
  'amsterdam': 'Europe/Amsterdam',
  'moscow': 'Europe/Moscow',
  'istanbul': 'Europe/Istanbul',
  'zurich': 'Europe/Zurich',

  // Asia
  'tokyo': 'Asia/Tokyo',
  'beijing': 'Asia/Shanghai',
  'shanghai': 'Asia/Shanghai',
  'hong kong': 'Asia/Hong_Kong',
  'singapore': 'Asia/Singapore',
  'mumbai': 'Asia/Kolkata',
  'delhi': 'Asia/Kolkata',
  'bangalore': 'Asia/Kolkata',
  'dubai': 'Asia/Dubai',
  'seoul': 'Asia/Seoul',
  'bangkok': 'Asia/Bangkok',
  'jakarta': 'Asia/Jakarta',
  'karachi': 'Asia/Karachi',
  'taipei': 'Asia/Taipei',

  // Oceania
  'sydney': 'Australia/Sydney',
  'melbourne': 'Australia/Melbourne',
  'auckland': 'Pacific/Auckland',

  // Africa
  'cairo': 'Africa/Cairo',
  'lagos': 'Africa/Lagos',
  'johannesburg': 'Africa/Johannesburg',
  'nairobi': 'Africa/Nairobi',

  // Common timezone abbreviations
  'utc': 'UTC',
  'gmt': 'UTC',
  'est': 'America/New_York',
  'pst': 'America/Los_Angeles',
  'cst': 'America/Chicago',
  'mst': 'America/Denver',
  'ist': 'Asia/Kolkata',
  'jst': 'Asia/Tokyo',
  'cet': 'Europe/Paris',
  'aest': 'Australia/Sydney',
};

// ─── Timezone extraction ─────────────────────────────────────────

export function extractTimezone(message: string): string | null {
  const lower = message.toLowerCase();

  // "time in <city>" or "time at <city>"
  const inMatch = lower.match(/\btime\s+(?:in|at)\s+(.+?)(?:\?|!|$)/);
  if (inMatch) {
    const city = inMatch[1].trim();
    if (CITY_TIMEZONE_MAP[city]) return CITY_TIMEZONE_MAP[city];
  }

  // Check if any known city appears anywhere in the message
  for (const [city, tz] of Object.entries(CITY_TIMEZONE_MAP)) {
    if (city.length > 2 && lower.includes(city)) return tz;
  }

  return null;
}

// ─── Formatting ──────────────────────────────────────────────────

function formatTime(date: Date, timezone: string): string {
  const timeStr = date.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const tzAbbr = date.toLocaleTimeString('en-US', {
    timeZone: timezone,
    timeZoneName: 'short',
  }).split(' ').pop() ?? timezone;

  return `${timeStr} ${tzAbbr}`;
}

function formatDate(date: Date, timezone: string): string {
  return date.toLocaleDateString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// ─── Handler ─────────────────────────────────────────────────────

function isDateQuery(message: string): boolean {
  const lower = message.toLowerCase();
  return /\b(date|day is it|what day|today)\b/.test(lower) && !/\btime\b/.test(lower);
}

export function handleTime(userMessage: string): ProcessedResponse {
  const now = new Date();
  const timezone = extractTimezone(userMessage) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const isDate = isDateQuery(userMessage);

  let content: string;
  if (isDate) {
    const dateStr = formatDate(now, timezone);
    content = `Today is **${dateStr}**.`;
  } else {
    const timeStr = formatTime(now, timezone);
    const dateStr = formatDate(now, timezone);
    const tzLabel = timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone
      ? ` (${timezone.replace(/_/g, ' ')})`
      : '';
    content = `It's **${timeStr}**${tzLabel} — ${dateStr}.`;
  }

  return {
    content,
    format: 'text',
    structuredData: null,
    skillId: 'builtin-time' as SkillId,
    suggestedActions: ['Time in another city'],
  };
}

// ─── Skill config (registered by index.ts) ───────────────────────

export const TIME_SKILL_CONFIG: BuiltInSkillConfig = {
  name: 'Time & Date',
  description: 'Get current time and date in any timezone',
  triggerPatterns: [
    'what time',
    'current time',
    'time now',
    'time in',
    'whats the time',
    'todays date',
    'what day is it',
    'what is the date',
    'current date',
    'what date',
  ],
  behaviorPrompt: 'Return current time and/or date.',
  inputSchema: null,
  outputFormat: 'text',
  schedule: null,
  dataTable: null,
  readableTables: [],
  tableSchema: null,
  requiredIntegrations: [],
};
