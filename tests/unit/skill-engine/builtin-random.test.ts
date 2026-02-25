import { describe, it, expect } from 'vitest';
import { handleRandom, classifyRequest } from '../../../src/skill-engine/builtin-skills/handlers/random-handler.js';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('Built-in Random Handler', () => {
  // ── classifyRequest ─────────────────────────────────────────

  describe('classifyRequest', () => {
    it('classifies UUID requests', () => {
      expect(classifyRequest('generate a uuid')).toEqual({ type: 'uuid' });
      expect(classifyRequest('give me a GUID')).toEqual({ type: 'uuid' });
    });

    it('classifies password requests with default length', () => {
      expect(classifyRequest('generate a password')).toEqual({ type: 'password', length: 16 });
    });

    it('classifies password requests with custom length', () => {
      expect(classifyRequest('generate a password 24 characters long')).toEqual({ type: 'password', length: 24 });
    });

    it('clamps password length to 8-128', () => {
      expect(classifyRequest('generate a password 3 characters')).toEqual({ type: 'password', length: 8 });
      expect(classifyRequest('generate a password 999 characters')).toEqual({ type: 'password', length: 128 });
    });

    it('classifies number with range', () => {
      expect(classifyRequest('random number between 5 and 50')).toEqual({ type: 'number', min: 5, max: 50 });
    });

    it('classifies number with default range', () => {
      expect(classifyRequest('give me a random number')).toEqual({ type: 'number', min: 1, max: 100 });
    });

    it('classifies "random between 1 to 10"', () => {
      const result = classifyRequest('random between 1 to 10');
      expect(result).toEqual({ type: 'number', min: 1, max: 10 });
    });
  });

  // ── handleRandom ────────────────────────────────────────────

  describe('handleRandom', () => {
    it('generates a valid UUID v4', () => {
      const result = handleRandom('generate a uuid');
      expect(result.skillId).toBe('builtin-random');
      expect(result.structuredData).not.toBeNull();
      expect((result.structuredData as Record<string, string>).uuid).toMatch(UUID_V4_REGEX);
      expect(result.content).toMatch(/`[0-9a-f-]+`/); // code-formatted UUID
    });

    it('generates a random number within bounds', () => {
      const result = handleRandom('random number between 5 and 50');
      expect(result.skillId).toBe('builtin-random');
      const num = (result.structuredData as Record<string, number>).number;
      expect(num).toBeGreaterThanOrEqual(5);
      expect(num).toBeLessThanOrEqual(50);
    });

    it('generates default 1-100 random number', () => {
      const result = handleRandom('random number');
      const num = (result.structuredData as Record<string, number>).number;
      expect(num).toBeGreaterThanOrEqual(1);
      expect(num).toBeLessThanOrEqual(100);
    });

    it('generates a password of default length', () => {
      const result = handleRandom('generate a password');
      expect(result.skillId).toBe('builtin-random');
      const pwd = (result.structuredData as Record<string, unknown>).password as string;
      expect(pwd).toHaveLength(16);
      expect(result.content).toContain('16-character');
    });

    it('generates a password of custom length', () => {
      const result = handleRandom('generate a password 24 characters');
      const pwd = (result.structuredData as Record<string, unknown>).password as string;
      expect(pwd).toHaveLength(24);
      expect(result.content).toContain('24-character');
    });

    it('includes suggested actions', () => {
      const result = handleRandom('generate a uuid');
      expect(result.suggestedActions.length).toBeGreaterThan(0);
    });

    it('random numbers are different on multiple calls', () => {
      // Not deterministic, but statistically this should hold
      const results = new Set<number>();
      for (let i = 0; i < 20; i++) {
        const r = handleRandom('random number between 1 and 1000000');
        results.add((r.structuredData as Record<string, number>).number);
      }
      expect(results.size).toBeGreaterThan(1); // at least 2 unique values
    });

    it('passwords contain mixed character types', () => {
      const result = handleRandom('generate password');
      const pwd = (result.structuredData as Record<string, unknown>).password as string;
      // Check for at least uppercase, lowercase, and digits
      expect(pwd).toMatch(/[A-Z]/);
      expect(pwd).toMatch(/[a-z]/);
      expect(pwd).toMatch(/[0-9]/);
    });
  });
});
