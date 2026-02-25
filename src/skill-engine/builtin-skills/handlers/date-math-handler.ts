/**
 * Built-in Date Math handler — Phase 3.6
 *
 * Handles: "how many days until Christmas", "2 weeks ago", "next Friday"
 * Pure date arithmetic — no external deps.
 */

import type { ProcessedResponse } from '../../../common/types/orchestrator.js';
import type { SkillId } from '../../../common/types/ids.js';
import type { BuiltInSkillConfig } from '../types.js';

// ─── Well-known dates ────────────────────────────────────────────

function getWellKnownDate(name: string, referenceYear: number): Date | null {
  const lower = name.toLowerCase().trim();
  const dates: Record<string, [number, number]> = {
    'christmas': [12, 25],
    'christmas day': [12, 25],
    'xmas': [12, 25],
    'new year': [1, 1],
    'new years': [1, 1],
    'new years day': [1, 1],
    "new year's": [1, 1],
    "new year's day": [1, 1],
    'valentine': [2, 14],
    "valentine's": [2, 14],
    "valentine's day": [2, 14],
    'valentines day': [2, 14],
    'halloween': [10, 31],
    'independence day': [7, 4],
    'july 4th': [7, 4],
    '4th of july': [7, 4],
    'thanksgiving': [11, 28], // approximate — 4th Thursday
    'easter': [4, 20],        // approximate
    'st patricks day': [3, 17],
    "st patrick's day": [3, 17],
  };

  const entry = dates[lower];
  if (!entry) return null;

  const [month, day] = entry;
  return new Date(referenceYear, month - 1, day);
}

// ─── Date parsing ────────────────────────────────────────────────

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Parse a date reference from natural language.
 * Supports: well-known dates, "March 5 2025", "next Friday", relative dates.
 */
export function parseDate(text: string, now: Date = new Date()): Date | null {
  const lower = text.toLowerCase().trim();

  // Check well-known dates first
  const wellKnown = getWellKnownDate(lower, now.getFullYear());
  if (wellKnown) return wellKnown;

  // "next <day>" — find the next occurrence of that weekday
  const nextDayMatch = lower.match(/\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (nextDayMatch) {
    const targetDay = DAY_NAMES.indexOf(nextDayMatch[1]);
    const currentDay = now.getDay();
    let daysAhead = targetDay - currentDay;
    if (daysAhead <= 0) daysAhead += 7;
    const result = new Date(now);
    result.setDate(result.getDate() + daysAhead);
    return startOfDay(result);
  }

  // "last <day>" — find the most recent past occurrence
  const lastDayMatch = lower.match(/\blast\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (lastDayMatch) {
    const targetDay = DAY_NAMES.indexOf(lastDayMatch[1]);
    const currentDay = now.getDay();
    let daysBack = currentDay - targetDay;
    if (daysBack <= 0) daysBack += 7;
    const result = new Date(now);
    result.setDate(result.getDate() - daysBack);
    return startOfDay(result);
  }

  // "<N> <unit> ago" or "<N> <unit> from now"
  const relativeMatch = lower.match(/(\d+)\s+(days?|weeks?|months?|years?)\s+(ago|from now|later)/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].replace(/s$/, '');
    const direction = relativeMatch[3] === 'ago' ? -1 : 1;
    const result = new Date(now);

    switch (unit) {
      case 'day':
        result.setDate(result.getDate() + amount * direction);
        break;
      case 'week':
        result.setDate(result.getDate() + amount * 7 * direction);
        break;
      case 'month':
        result.setMonth(result.getMonth() + amount * direction);
        break;
      case 'year':
        result.setFullYear(result.getFullYear() + amount * direction);
        break;
    }
    return startOfDay(result);
  }

  // "tomorrow"
  if (/\btomorrow\b/.test(lower)) {
    const result = new Date(now);
    result.setDate(result.getDate() + 1);
    return startOfDay(result);
  }

  // "yesterday"
  if (/\byesterday\b/.test(lower)) {
    const result = new Date(now);
    result.setDate(result.getDate() - 1);
    return startOfDay(result);
  }

  // Explicit date: "March 5 2025", "December 25, 2026", "Jan 1"
  const explicitMatch = lower.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\b/,
  );
  if (explicitMatch) {
    const monthStr = explicitMatch[1];
    const day = parseInt(explicitMatch[2], 10);
    const year = explicitMatch[3] ? parseInt(explicitMatch[3], 10) : now.getFullYear();
    const monthIndex = parseMonth(monthStr);
    if (monthIndex >= 0) {
      return new Date(year, monthIndex, day);
    }
  }

  return null;
}

function parseMonth(str: string): number {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const prefix = str.slice(0, 3).toLowerCase();
  return months.indexOf(prefix);
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── Day counting ────────────────────────────────────────────────

function daysBetween(a: Date, b: Date): number {
  const msPerDay = 86_400_000;
  const aStart = startOfDay(a).getTime();
  const bStart = startOfDay(b).getTime();
  return Math.round((bStart - aStart) / msPerDay);
}

function formatDateNice(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// ─── Extract target from message ─────────────────────────────────

function extractTarget(message: string): string {
  const lower = message.toLowerCase();

  // "days until <target>" / "how long until <target>"
  const untilMatch = lower.match(/\b(?:days?|weeks?|how long|time)\s+(?:until|till|to|before)\s+(.+?)(?:\?|!|$)/);
  if (untilMatch) return untilMatch[1].trim();

  // "days since <target>" / "how long since <target>"
  const sinceMatch = lower.match(/\b(?:days?|weeks?|how long|time)\s+since\s+(.+?)(?:\?|!|$)/);
  if (sinceMatch) return sinceMatch[1].trim();

  // "what day was <target>" / "what date was <target>"
  const wasMatch = lower.match(/\bwhat\s+(?:day|date)\s+(?:was|is)\s+(.+?)(?:\?|!|$)/);
  if (wasMatch) return wasMatch[1].trim();

  // "days between <date1> and <date2>"
  const betweenMatch = lower.match(/\bdays?\s+between\s+(.+?)\s+and\s+(.+?)(?:\?|!|$)/);
  if (betweenMatch) return message; // return full message for special handling

  // Fallback: return everything after common prefixes
  const fallback = lower.replace(/^(how many |what |when |how long |tell me )/, '').trim();
  return fallback;
}

// ─── Handler ─────────────────────────────────────────────────────

export function handleDateMath(userMessage: string): ProcessedResponse {
  const now = new Date();
  const lower = userMessage.toLowerCase();

  // Special case: "days between X and Y"
  const betweenMatch = lower.match(/\bdays?\s+between\s+(.+?)\s+and\s+(.+?)(?:\?|!|$)/);
  if (betweenMatch) {
    const date1 = parseDate(betweenMatch[1].trim(), now);
    const date2 = parseDate(betweenMatch[2].trim(), now);
    if (date1 && date2) {
      const days = Math.abs(daysBetween(date1, date2));
      const weeks = Math.floor(days / 7);
      return makeResponse(
        `There are **${days} days** (about ${weeks} weeks) between ${formatDateNice(date1)} and ${formatDateNice(date2)}.`,
      );
    }
    return makeResponse("I couldn't parse both dates. Try something like \"days between March 5 and June 10\".");
  }

  const target = extractTarget(userMessage);
  const targetDate = parseDate(target, now);

  if (!targetDate) {
    return makeResponse(
      "I couldn't figure out which date you mean. Try something like \"days until Christmas\" or \"2 weeks ago\".",
    );
  }

  const days = daysBetween(now, targetDate);

  // "what day was X" — return day of week
  if (/\bwhat\s+(?:day|date)\s+(?:was|is)\b/.test(lower)) {
    return makeResponse(`${formatDateNice(targetDate)}.`);
  }

  // Today
  if (days === 0) {
    return makeResponse(`That's **today** — ${formatDateNice(now)}!`);
  }

  // Future date (days until)
  if (days > 0) {
    const weeks = Math.floor(days / 7);
    const weeksStr = weeks > 0 ? ` That's about **${weeks} week${weeks === 1 ? '' : 's'}**.` : '';
    return makeResponse(
      `There are **${days} day${days === 1 ? '' : 's'}** until ${formatDateNice(targetDate)}.${weeksStr}`,
    );
  }

  // Past date (days since)
  const absDays = Math.abs(days);
  const weeks = Math.floor(absDays / 7);
  const weeksStr = weeks > 0 ? ` That's about **${weeks} week${weeks === 1 ? '' : 's'}**.` : '';

  // "days until" something past → clarify
  if (/\buntil\b/.test(lower)) {
    // Check next year
    const nextYear = new Date(targetDate);
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    const daysNext = daysBetween(now, nextYear);
    if (daysNext > 0) {
      const weeksNext = Math.floor(daysNext / 7);
      const weeksNextStr = weeksNext > 0 ? ` That's about **${weeksNext} week${weeksNext === 1 ? '' : 's'}**.` : '';
      return makeResponse(
        `That was **${absDays} day${absDays === 1 ? '' : 's'}** ago. The next one is in **${daysNext} days** (${formatDateNice(nextYear)}).${weeksNextStr}`,
      );
    }
  }

  return makeResponse(
    `That was **${absDays} day${absDays === 1 ? '' : 's'}** ago (${formatDateNice(targetDate)}).${weeksStr}`,
  );
}

function makeResponse(content: string): ProcessedResponse {
  return {
    content,
    format: 'text',
    structuredData: null,
    skillId: 'builtin-date-math' as SkillId,
    suggestedActions: ['Another date calculation'],
  };
}

// ─── Skill config (registered by index.ts) ───────────────────────

export const DATE_MATH_SKILL_CONFIG: BuiltInSkillConfig = {
  name: 'Date Math',
  description: 'Calculate days between dates, countdowns, and relative dates',
  triggerPatterns: [
    'days until',
    'days since',
    'how long until',
    'how long since',
    'weeks until',
    'weeks since',
    'what day was',
    'what date was',
    'days between',
    'how many days',
  ],
  behaviorPrompt: 'Calculate dates and durations.',
  inputSchema: null,
  outputFormat: 'text',
  schedule: null,
  dataTable: null,
  readableTables: [],
  tableSchema: null,
  requiredIntegrations: [],
};
