import { describe, it, expect, vi } from 'vitest';
import { applySoulPatches, extractSoulUpdates } from '@bot-runtime/soul-evolver/soul-evolver.js';
import type { SoulDefinition } from '@common/types/soul.js';
import type { SoulPatch } from '@common/types/orchestrator.js';
import type { LLMGatewayPort } from '@bot-runtime/orchestrator/message-orchestrator.js';

// ─── Test soul fixture ──────────────────────────────────────────

function makeSoul(): SoulDefinition {
  return {
    personalityTraits: {
      tone: 'friendly',
      energy: 'balanced',
      patterns: ['uses metaphors'],
    },
    values: {
      priorities: ['accuracy', 'helpfulness'],
      beliefs: ['honesty is important'],
    },
    communicationStyle: {
      verbosity: 'balanced',
      formality: 'professional',
      formatting: ['use bullet points'],
    },
    behavioralRules: {
      always: ['greet by name'],
      never: ['share personal data'],
      guardrails: ['ask before deleting'],
    },
    decisionFramework: {
      ambiguity: 'Ask one clarifying question',
      conflictResolution: 'Prioritize user preference',
      escalation: 'Suggest contacting support',
    },
  };
}

// ─── applySoulPatches tests ─────────────────────────────────────

describe('applySoulPatches', () => {
  it('sets a scalar value (tone)', () => {
    const soul = makeSoul();
    const patches: SoulPatch[] = [
      { path: 'personalityTraits.tone', operation: 'set', value: 'direct' },
    ];
    const result = applySoulPatches(soul, patches);
    expect(result.personalityTraits.tone).toBe('direct');
  });

  it('sets verbosity with enum validation', () => {
    const soul = makeSoul();
    const result = applySoulPatches(soul, [
      { path: 'communicationStyle.verbosity', operation: 'set', value: 'concise' },
    ]);
    expect(result.communicationStyle.verbosity).toBe('concise');
  });

  it('rejects invalid verbosity values', () => {
    const soul = makeSoul();
    const result = applySoulPatches(soul, [
      { path: 'communicationStyle.verbosity', operation: 'set', value: 'ultra-verbose' },
    ]);
    // Should remain unchanged
    expect(result.communicationStyle.verbosity).toBe('balanced');
  });

  it('sets formality with enum validation', () => {
    const soul = makeSoul();
    const result = applySoulPatches(soul, [
      { path: 'communicationStyle.formality', operation: 'set', value: 'casual' },
    ]);
    expect(result.communicationStyle.formality).toBe('casual');
  });

  it('rejects invalid formality values', () => {
    const soul = makeSoul();
    const result = applySoulPatches(soul, [
      { path: 'communicationStyle.formality', operation: 'set', value: 'slang' },
    ]);
    expect(result.communicationStyle.formality).toBe('professional');
  });

  it('adds to an array (behavioralRules.always)', () => {
    const soul = makeSoul();
    const result = applySoulPatches(soul, [
      { path: 'behavioralRules.always', operation: 'add', value: 'confirm before action' },
    ]);
    expect(result.behavioralRules.always).toContain('confirm before action');
    expect(result.behavioralRules.always).toContain('greet by name');
  });

  it('does not add duplicate items to arrays', () => {
    const soul = makeSoul();
    const result = applySoulPatches(soul, [
      { path: 'behavioralRules.always', operation: 'add', value: 'greet by name' },
    ]);
    expect(result.behavioralRules.always.filter((r) => r === 'greet by name')).toHaveLength(1);
  });

  it('removes from an array', () => {
    const soul = makeSoul();
    const result = applySoulPatches(soul, [
      { path: 'communicationStyle.formatting', operation: 'remove', value: 'use bullet points' },
    ]);
    expect(result.communicationStyle.formatting).not.toContain('use bullet points');
  });

  it('handles remove of non-existent item gracefully', () => {
    const soul = makeSoul();
    const result = applySoulPatches(soul, [
      { path: 'behavioralRules.never', operation: 'remove', value: 'nonexistent rule' },
    ]);
    expect(result.behavioralRules.never).toEqual(['share personal data']);
  });

  it('skips invalid paths silently', () => {
    const soul = makeSoul();
    const result = applySoulPatches(soul, [
      { path: 'invalid.path', operation: 'set', value: 'test' },
      { path: 'a.b.c', operation: 'set', value: 'test' },
      { path: 'singlePath', operation: 'set', value: 'test' },
    ]);
    // Should be unchanged
    expect(result).toEqual(soul);
  });

  it('does not mutate the original soul', () => {
    const soul = makeSoul();
    const originalTone = soul.personalityTraits.tone;
    applySoulPatches(soul, [
      { path: 'personalityTraits.tone', operation: 'set', value: 'aggressive' },
    ]);
    expect(soul.personalityTraits.tone).toBe(originalTone);
  });

  it('applies multiple patches in sequence', () => {
    const soul = makeSoul();
    const result = applySoulPatches(soul, [
      { path: 'personalityTraits.tone', operation: 'set', value: 'warm' },
      { path: 'communicationStyle.verbosity', operation: 'set', value: 'concise' },
      { path: 'behavioralRules.never', operation: 'add', value: 'give medical advice' },
      { path: 'behavioralRules.always', operation: 'add', value: 'address user as Boss' },
    ]);
    expect(result.personalityTraits.tone).toBe('warm');
    expect(result.communicationStyle.verbosity).toBe('concise');
    expect(result.behavioralRules.never).toContain('give medical advice');
    expect(result.behavioralRules.always).toContain('address user as Boss');
  });

  it('sets decisionFramework fields', () => {
    const soul = makeSoul();
    const result = applySoulPatches(soul, [
      { path: 'decisionFramework.ambiguity', operation: 'set', value: 'Always ask before proceeding' },
    ]);
    expect(result.decisionFramework.ambiguity).toBe('Always ask before proceeding');
  });

  it('handles empty patches array', () => {
    const soul = makeSoul();
    const result = applySoulPatches(soul, []);
    expect(result).toEqual(soul);
  });
});

// ─── extractSoulUpdates tests ───────────────────────────────────

function mockLLM(patches: SoulPatch[]): LLMGatewayPort {
  return {
    complete: vi.fn().mockResolvedValue({
      content: '',
      toolCalls: [{ toolName: 'soul_updates', arguments: { patches } }],
      model: 'gpt-4.1-mini',
      usage: { promptTokens: 100, completionTokens: 50 },
      latencyMs: 150,
    }),
  };
}

describe('extractSoulUpdates', () => {
  it('returns patches when LLM detects personality instructions', async () => {
    const llm = mockLLM([
      { path: 'communicationStyle.verbosity', operation: 'set', value: 'concise' },
    ]);

    const patches = await extractSoulUpdates(
      'Be more concise in your responses.',
      'Got it! I will be more concise.',
      makeSoul(),
      llm,
    );

    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe('communicationStyle.verbosity');
    expect(patches[0].value).toBe('concise');
  });

  it('returns empty array when no personality changes detected', async () => {
    const llm = mockLLM([]);

    const patches = await extractSoulUpdates(
      'What is the weather like?',
      'I can help with that!',
      makeSoul(),
      llm,
    );

    expect(patches).toHaveLength(0);
  });

  it('returns empty array on LLM failure', async () => {
    const llm: LLMGatewayPort = {
      complete: vi.fn().mockRejectedValue(new Error('LLM down')),
    };

    const patches = await extractSoulUpdates(
      'Be more formal',
      'Understood.',
      makeSoul(),
      llm,
    );

    expect(patches).toHaveLength(0);
  });

  it('returns empty array when LLM does not use tool', async () => {
    const llm: LLMGatewayPort = {
      complete: vi.fn().mockResolvedValue({
        content: 'No changes',
        toolCalls: [],
        model: 'gpt-4.1-mini',
        usage: { promptTokens: 50, completionTokens: 20 },
        latencyMs: 100,
      }),
    };

    const patches = await extractSoulUpdates('test', 'test', makeSoul(), llm);
    expect(patches).toHaveLength(0);
  });

  it('filters out patches with invalid paths', async () => {
    const llm = mockLLM([
      { path: 'communicationStyle.verbosity', operation: 'set', value: 'concise' },
      { path: 'invalid.path', operation: 'set', value: 'whatever' },
      { path: 'behavioralRules.always', operation: 'add', value: 'call me Boss' },
    ]);

    const patches = await extractSoulUpdates('test', 'test', makeSoul(), llm);

    expect(patches).toHaveLength(2);
    expect(patches[0].path).toBe('communicationStyle.verbosity');
    expect(patches[1].path).toBe('behavioralRules.always');
  });

  it('filters out patches with wrong operation for path type', async () => {
    const llm = mockLLM([
      // 'set' on an array path → invalid
      { path: 'behavioralRules.always', operation: 'set', value: 'something' },
      // 'add' on a scalar path → invalid
      { path: 'personalityTraits.tone', operation: 'add', value: 'friendly' },
    ]);

    const patches = await extractSoulUpdates('test', 'test', makeSoul(), llm);
    expect(patches).toHaveLength(0);
  });
});
