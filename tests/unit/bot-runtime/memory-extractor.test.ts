import { describe, it, expect, vi } from 'vitest';
import { regexExtractMemoryFacts, extractMemoryFacts } from '@bot-runtime/memory-extractor/memory-extractor.js';
import type { LLMGatewayPort } from '@bot-runtime/orchestrator/message-orchestrator.js';
import type { MemoryFact } from '@common/types/orchestrator.js';

// ─── Regex fallback tests (unchanged behavior) ─────────────────

describe('regexExtractMemoryFacts', () => {
  it('extracts business name from "my bakery is called X"', () => {
    const facts = regexExtractMemoryFacts('My bakery is called Sweet Crumb Bakery');
    expect(facts.some((f) => f.key === 'business_name' && f.value === 'Sweet Crumb Bakery')).toBe(true);
  });

  it('extracts business name from "our company is X"', () => {
    const facts = regexExtractMemoryFacts('Our company is Acme Design Studio');
    expect(facts.some((f) => f.key === 'business_name' && f.value === 'Acme Design Studio')).toBe(true);
  });

  it('extracts team size', () => {
    const facts = regexExtractMemoryFacts('I have 5 employees at the shop');
    expect(facts.some((f) => f.key === 'team_size' && f.value === '5')).toBe(true);
  });

  it('extracts location', () => {
    const facts = regexExtractMemoryFacts("We're based in Portland, Oregon");
    expect(facts.some((f) => f.key === 'location')).toBe(true);
  });

  it('extracts business hours', () => {
    const facts = regexExtractMemoryFacts("We're open 7am to 5pm Monday through Saturday");
    expect(facts.some((f) => f.key === 'business_hours')).toBe(true);
  });

  it('returns empty array for messages with no extractable facts', () => {
    const facts = regexExtractMemoryFacts('What orders do I have this week?');
    expect(facts).toHaveLength(0);
  });

  it('returns empty array for empty message', () => {
    const facts = regexExtractMemoryFacts('');
    expect(facts).toHaveLength(0);
  });

  it('extracts multiple facts from a single message', () => {
    const facts = regexExtractMemoryFacts(
      "My bakery is called Sweet Crumb and I have 5 employees"
    );
    expect(facts.length).toBeGreaterThanOrEqual(2);
  });

  it('sets source to user_stated', () => {
    const facts = regexExtractMemoryFacts('My bakery is called Sweet Crumb');
    expect(facts[0].source).toBe('user_stated');
  });

  it('sets confidence > 0', () => {
    const facts = regexExtractMemoryFacts('My bakery is called Sweet Crumb');
    expect(facts[0].confidence).toBeGreaterThan(0);
  });

  it('skips very short extracted values', () => {
    const facts = regexExtractMemoryFacts('My shop is called A');
    for (const fact of facts) {
      expect(fact.value.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ─── LLM-powered extraction tests ──────────────────────────────

function mockLLM(toolCallResult: Record<string, unknown>): LLMGatewayPort {
  return {
    complete: vi.fn().mockResolvedValue({
      content: '',
      toolCalls: [{ toolName: 'extract_facts', arguments: toolCallResult }],
      model: 'gpt-4.1-mini',
      usage: { promptTokens: 100, completionTokens: 50 },
      latencyMs: 200,
    }),
  };
}

function mockLLMNoToolCall(): LLMGatewayPort {
  return {
    complete: vi.fn().mockResolvedValue({
      content: 'No facts found',
      toolCalls: [],
      model: 'gpt-4.1-mini',
      usage: { promptTokens: 100, completionTokens: 50 },
      latencyMs: 200,
    }),
  };
}

function mockLLMError(): LLMGatewayPort {
  return {
    complete: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
  };
}

describe('extractMemoryFacts (LLM-powered)', () => {
  const existingFacts: MemoryFact[] = [
    { key: 'user_name', value: 'Dhruv', source: 'user_stated', confidence: 0.9, createdAt: new Date() },
  ];

  it('extracts facts via LLM tool call', async () => {
    const llm = mockLLM({
      facts: [
        { key: 'business_name', value: 'Sweet Crumb', source: 'user_stated', confidence: 0.95 },
        { key: 'location', value: 'Austin, TX', source: 'user_stated', confidence: 0.9 },
      ],
    });

    const facts = await extractMemoryFacts(
      'My bakery Sweet Crumb is in Austin, TX',
      'Great! Sweet Crumb in Austin sounds wonderful.',
      existingFacts,
      llm,
    );

    expect(facts).toHaveLength(2);
    expect(facts[0].key).toBe('business_name');
    expect(facts[0].value).toBe('Sweet Crumb');
    expect(facts[1].key).toBe('location');
    expect(facts[1].confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('returns empty array when LLM returns empty facts', async () => {
    const llm = mockLLM({ facts: [] });

    const facts = await extractMemoryFacts(
      'What is the weather like?',
      'I can help with that!',
      [],
      llm,
    );

    expect(facts).toHaveLength(0);
  });

  it('falls back to regex when LLM does not use tool', async () => {
    const llm = mockLLMNoToolCall();

    const facts = await extractMemoryFacts(
      'My bakery is called Sweet Crumb',
      'Nice!',
      [],
      llm,
    );

    // Should get regex result
    expect(facts.some((f) => f.key === 'business_name')).toBe(true);
  });

  it('falls back to regex when LLM call fails', async () => {
    const llm = mockLLMError();

    const facts = await extractMemoryFacts(
      'My bakery is called Sweet Crumb',
      'Nice!',
      [],
      llm,
    );

    // Should get regex result as fallback
    expect(facts.some((f) => f.key === 'business_name')).toBe(true);
  });

  it('passes existing facts to LLM for dedup context', async () => {
    const llm = mockLLM({ facts: [] });

    await extractMemoryFacts(
      'My name is Dhruv',
      'Hi Dhruv!',
      existingFacts,
      llm,
    );

    // Verify the LLM was called with a prompt that includes existing facts
    const callArgs = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = callArgs[0];
    expect(prompt.messages[0].content).toContain('user_name');
    expect(prompt.messages[0].content).toContain('Dhruv');
  });

  it('clamps confidence values to valid range', async () => {
    const llm = mockLLM({
      facts: [
        { key: 'test', value: 'val', source: 'user_stated', confidence: 1.5 },
        { key: 'test2', value: 'val2', source: 'inferred', confidence: 0.1 },
      ],
    });

    const facts = await extractMemoryFacts('test', 'response', [], llm);

    expect(facts[0].confidence).toBeLessThanOrEqual(1.0);
    expect(facts[1].confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('filters out facts with empty keys or values', async () => {
    const llm = mockLLM({
      facts: [
        { key: '', value: 'val', source: 'user_stated', confidence: 0.9 },
        { key: 'valid', value: '', source: 'user_stated', confidence: 0.9 },
        { key: 'good', value: 'data', source: 'user_stated', confidence: 0.9 },
      ],
    });

    const facts = await extractMemoryFacts('test', 'response', [], llm);

    expect(facts).toHaveLength(1);
    expect(facts[0].key).toBe('good');
  });
});
