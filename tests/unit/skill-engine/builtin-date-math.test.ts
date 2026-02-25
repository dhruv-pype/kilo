import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleDateMath, parseDate } from '../../../src/skill-engine/builtin-skills/handlers/date-math-handler.js';

describe('Built-in Date Math Handler', () => {
  // Use a fixed "now" for deterministic tests
  const fixedNow = new Date('2026-06-15T12:00:00Z');

  // ── parseDate ─────────────────────────────────────────────

  describe('parseDate', () => {
    it('parses "Christmas" as December 25', () => {
      const result = parseDate('Christmas', fixedNow);
      expect(result).not.toBeNull();
      expect(result!.getMonth()).toBe(11); // December = 11
      expect(result!.getDate()).toBe(25);
    });

    it('parses "New Year" as January 1', () => {
      const result = parseDate("New Year's", fixedNow);
      expect(result).not.toBeNull();
      expect(result!.getMonth()).toBe(0);
      expect(result!.getDate()).toBe(1);
    });

    it('parses "next Friday"', () => {
      const result = parseDate('next friday', fixedNow);
      expect(result).not.toBeNull();
      expect(result!.getDay()).toBe(5); // Friday
      expect(result!.getTime()).toBeGreaterThan(fixedNow.getTime());
    });

    it('parses "2 weeks ago"', () => {
      const result = parseDate('2 weeks ago', fixedNow);
      expect(result).not.toBeNull();
      const expected = new Date(fixedNow);
      expected.setDate(expected.getDate() - 14);
      expected.setHours(0, 0, 0, 0);
      expect(result!.getTime()).toBe(expected.getTime());
    });

    it('parses "3 months from now"', () => {
      const result = parseDate('3 months from now', fixedNow);
      expect(result).not.toBeNull();
      expect(result!.getMonth()).toBe(8); // September
    });

    it('parses "March 5 2025"', () => {
      const result = parseDate('March 5 2025', fixedNow);
      expect(result).not.toBeNull();
      expect(result!.getFullYear()).toBe(2025);
      expect(result!.getMonth()).toBe(2); // March
      expect(result!.getDate()).toBe(5);
    });

    it('parses "tomorrow"', () => {
      const result = parseDate('tomorrow', fixedNow);
      expect(result).not.toBeNull();
      expect(result!.getDate()).toBe(fixedNow.getDate() + 1);
    });

    it('parses "yesterday"', () => {
      const result = parseDate('yesterday', fixedNow);
      expect(result).not.toBeNull();
      expect(result!.getDate()).toBe(fixedNow.getDate() - 1);
    });

    it('returns null for unparseable text', () => {
      expect(parseDate('something random', fixedNow)).toBeNull();
    });
  });

  // ── handleDateMath ────────────────────────────────────────

  describe('handleDateMath', () => {
    it('calculates "days until Christmas"', () => {
      // From June 15 to Dec 25 = 193 days
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      const result = handleDateMath('how many days until Christmas?');
      expect(result.content).toMatch(/\*\*193 days?\*\*/);
      expect(result.skillId).toBe('builtin-date-math');

      vi.useRealTimers();
    });

    it('calculates "days since January 1"', () => {
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      const result = handleDateMath('how many days since January 1?');
      // Jan 1 2026 to Jun 15 2026 = 165 days
      expect(result.content).toMatch(/\*\*165 days?\*\*/);

      vi.useRealTimers();
    });

    it('returns day of week for "what day was March 5 2025"', () => {
      const result = handleDateMath('what day was March 5 2025?');
      expect(result.content).toMatch(/Wednesday/);
      expect(result.skillId).toBe('builtin-date-math');
    });

    it('handles "days between" two dates', () => {
      const result = handleDateMath('days between March 1 and June 1');
      // March 1 to June 1 = 92 days
      expect(result.content).toMatch(/\*\*92 days?\*\*/);
    });

    it('handles target date that is today', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-12-25T12:00:00Z'));

      const result = handleDateMath('how many days until Christmas?');
      expect(result.content).toMatch(/today/i);

      vi.useRealTimers();
    });

    it('handles past date for "days until" with next year hint', () => {
      vi.useFakeTimers();
      // Set to Feb 1, 2026 — "days until New Year" would be past (Jan 1 2026)
      vi.setSystemTime(new Date('2026-02-01T12:00:00Z'));

      const result = handleDateMath('how many days until New Year?');
      // Should mention it was X days ago and next one is in Y days
      expect(result.content).toMatch(/ago/);
      expect(result.content).toMatch(/next/);

      vi.useRealTimers();
    });

    it('returns error message for unparseable dates', () => {
      const result = handleDateMath('how many days until the meaning of life?');
      expect(result.content).toMatch(/couldn't figure out/i);
    });

    it('includes suggested actions', () => {
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      const result = handleDateMath('days until Christmas');
      expect(result.suggestedActions.length).toBeGreaterThan(0);

      vi.useRealTimers();
    });
  });
});
