import { describe, it, expect } from 'vitest';
import { handleTime, extractTimezone } from '../../../src/skill-engine/builtin-skills/handlers/time-handler.js';

describe('Built-in Time Handler', () => {
  // ── extractTimezone ─────────────────────────────────────────

  describe('extractTimezone', () => {
    it('extracts timezone from "time in Tokyo"', () => {
      expect(extractTimezone('what time is it in Tokyo?')).toBe('Asia/Tokyo');
    });

    it('extracts timezone from "time in New York"', () => {
      expect(extractTimezone('current time in new york')).toBe('America/New_York');
    });

    it('extracts timezone from "time in London"', () => {
      expect(extractTimezone('time in London?')).toBe('Europe/London');
    });

    it('extracts timezone from message containing a city name', () => {
      expect(extractTimezone('What about Sydney time?')).toBe('Australia/Sydney');
    });

    it('returns null for messages without a known city', () => {
      expect(extractTimezone('what time is it?')).toBeNull();
    });

    it('is case insensitive', () => {
      expect(extractTimezone('TIME IN LONDON')).toBe('Europe/London');
    });

    it('handles timezone abbreviations', () => {
      expect(extractTimezone('what time in pst?')).toBe('America/Los_Angeles');
    });
  });

  // ── handleTime ──────────────────────────────────────────────

  describe('handleTime', () => {
    it('returns current time for a basic query', () => {
      const result = handleTime('what time is it?');
      expect(result.content).toMatch(/It's \*\*.+\*\*/); // bold time
      expect(result.skillId).toBe('builtin-time');
      expect(result.format).toBe('text');
    });

    it('returns date for "what day is it"', () => {
      const result = handleTime('what day is it?');
      expect(result.content).toMatch(/Today is \*\*.+\*\*/);
      expect(result.skillId).toBe('builtin-time');
    });

    it('returns date for "todays date"', () => {
      const result = handleTime("what is today's date?");
      // "today" + "date" → date query
      expect(result.content).toMatch(/Today is \*\*/);
    });

    it('includes timezone label for a city query', () => {
      const result = handleTime('what time is it in Tokyo?');
      expect(result.content).toMatch(/Asia\/Tokyo|JST/);
      expect(result.content).toMatch(/\*\*/); // bold formatting
    });

    it('includes suggested actions', () => {
      const result = handleTime('what time is it?');
      expect(result.suggestedActions).toContain('Time in another city');
    });

    it('handles "time now" query', () => {
      const result = handleTime('time now');
      expect(result.content).toMatch(/It's \*\*/);
      expect(result.skillId).toBe('builtin-time');
    });
  });
});
