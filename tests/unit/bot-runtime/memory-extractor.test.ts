import { describe, it, expect } from 'vitest';
import { extractMemoryFacts } from '@bot-runtime/memory-extractor/memory-extractor.js';

describe('extractMemoryFacts', () => {
  it('extracts business name from "my bakery is called X"', () => {
    const facts = extractMemoryFacts('My bakery is called Sweet Crumb Bakery');
    expect(facts.some((f) => f.key === 'business_name' && f.value === 'Sweet Crumb Bakery')).toBe(true);
  });

  it('extracts business name from "our company is X"', () => {
    const facts = extractMemoryFacts('Our company is Acme Design Studio');
    expect(facts.some((f) => f.key === 'business_name' && f.value === 'Acme Design Studio')).toBe(true);
  });

  it('extracts team size', () => {
    const facts = extractMemoryFacts('I have 5 employees at the shop');
    expect(facts.some((f) => f.key === 'team_size' && f.value === '5')).toBe(true);
  });

  it('extracts location', () => {
    const facts = extractMemoryFacts("We're based in Portland, Oregon");
    expect(facts.some((f) => f.key === 'location')).toBe(true);
  });

  it('extracts business hours', () => {
    const facts = extractMemoryFacts("We're open 7am to 5pm Monday through Saturday");
    expect(facts.some((f) => f.key === 'business_hours')).toBe(true);
  });

  it('returns empty array for messages with no extractable facts', () => {
    const facts = extractMemoryFacts('What orders do I have this week?');
    expect(facts).toHaveLength(0);
  });

  it('returns empty array for empty message', () => {
    const facts = extractMemoryFacts('');
    expect(facts).toHaveLength(0);
  });

  it('extracts multiple facts from a single message', () => {
    const facts = extractMemoryFacts(
      "My bakery is called Sweet Crumb and I have 5 employees"
    );
    expect(facts.length).toBeGreaterThanOrEqual(2);
  });

  it('sets source to user_stated', () => {
    const facts = extractMemoryFacts('My bakery is called Sweet Crumb');
    expect(facts[0].source).toBe('user_stated');
  });

  it('sets confidence > 0', () => {
    const facts = extractMemoryFacts('My bakery is called Sweet Crumb');
    expect(facts[0].confidence).toBeGreaterThan(0);
  });

  it('skips very short extracted values', () => {
    // "My business is X" where X is just one letter — likely a false positive
    const facts = extractMemoryFacts('My shop is called A');
    // Should either not extract or extract with short value
    for (const fact of facts) {
      expect(fact.value.length).toBeGreaterThanOrEqual(2);
    }
  });
});
