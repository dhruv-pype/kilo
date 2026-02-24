import { describe, it, expect, vi } from 'vitest';
import { LLMGateway, defaultModelRoutes } from '@llm-gateway/llm-gateway.js';
import type { LLMProvider, ProviderRequest, ProviderResponse } from '@llm-gateway/types.js';

// ─── Mock Provider ──────────────────────────────────────────────

function mockProvider(name: string): LLMProvider & { lastRequest?: ProviderRequest } {
  const provider: LLMProvider & { lastRequest?: ProviderRequest } = {
    name,
    isAvailable: () => true,
    complete: vi.fn(async (request: ProviderRequest): Promise<ProviderResponse> => {
      provider.lastRequest = request;
      return {
        content: 'Response',
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5 },
        model: request.model,
      };
    }),
  };
  return provider;
}

// ─── Tests ───────────────────────────────────────────────────────

describe('LLMGateway — route configuration', () => {
  it('uses per-route maxTokens in provider request', async () => {
    const anthropic = mockProvider('anthropic');
    const gateway = new LLMGateway([anthropic], [
      {
        taskType: 'skill_execution',
        primary: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
        fallback: null,
        maxTokens: 8192,
      },
    ]);

    await gateway.complete(
      { system: 'test', messages: [{ role: 'user', content: 'hello' }], tools: [] },
      { taskType: 'skill_execution', streaming: false },
    );

    expect(anthropic.lastRequest?.maxTokens).toBe(8192);
  });

  it('passes thinking config from route to provider request', async () => {
    const anthropic = mockProvider('anthropic');
    const gateway = new LLMGateway([anthropic], [
      {
        taskType: 'doc_extraction',
        primary: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
        fallback: null,
        thinking: { type: 'enabled', budgetTokens: 8000 },
        maxTokens: 12288,
      },
    ]);

    await gateway.complete(
      { system: 'test', messages: [{ role: 'user', content: 'analyze this' }], tools: [] },
      { taskType: 'doc_extraction', streaming: false },
    );

    expect(anthropic.lastRequest?.thinking).toEqual({ type: 'enabled', budgetTokens: 8000 });
    expect(anthropic.lastRequest?.maxTokens).toBe(12288);
  });

  it('fallback requests do not include thinking config', async () => {
    const anthropic = mockProvider('anthropic');
    const openai = mockProvider('openai');

    // Make anthropic fail so it falls back to openai
    (anthropic.complete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Primary failed'));

    const gateway = new LLMGateway([anthropic, openai], [
      {
        taskType: 'skill_execution',
        primary: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
        fallback: { provider: 'openai', model: 'gpt-4o' },
        thinking: { type: 'enabled', budgetTokens: 5000 },
        maxTokens: 8192,
      },
    ]);

    await gateway.complete(
      { system: 'test', messages: [{ role: 'user', content: 'hello' }], tools: [] },
      { taskType: 'skill_execution', streaming: false },
    );

    // Fallback request should NOT have thinking
    expect(openai.lastRequest?.thinking).toBeUndefined();
    // Fallback should use default maxTokens (2048)
    expect(openai.lastRequest?.maxTokens).toBe(2048);
  });

  it('passes thinkingSummary through to LLMResponse', async () => {
    const anthropic = mockProvider('anthropic');
    (anthropic.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: 'Answer',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 50 },
      model: 'claude-sonnet-4-5-20250929',
      thinkingSummary: 'I thought about this carefully...',
    });

    const gateway = new LLMGateway([anthropic], [
      {
        taskType: 'skill_execution',
        primary: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
        fallback: null,
        thinking: { type: 'enabled', budgetTokens: 5000 },
        maxTokens: 8192,
      },
    ]);

    const result = await gateway.complete(
      { system: 'test', messages: [{ role: 'user', content: 'hello' }], tools: [] },
      { taskType: 'skill_execution', streaming: false },
    );

    expect(result.thinkingSummary).toBe('I thought about this carefully...');
  });

  it('defaultModelRoutes() has correct thinking configuration', () => {
    const routes = defaultModelRoutes();

    // simple_qa — no thinking
    const simpleQa = routes.find((r) => r.taskType === 'simple_qa');
    expect(simpleQa?.thinking).toBeUndefined();
    expect(simpleQa?.maxTokens).toBeUndefined();

    // skill_execution — thinking enabled
    const skillExec = routes.find((r) => r.taskType === 'skill_execution');
    expect(skillExec?.thinking).toEqual({ type: 'enabled', budgetTokens: 5_000 });
    expect(skillExec?.maxTokens).toBe(8_192);

    // complex_reasoning — highest budget
    const complex = routes.find((r) => r.taskType === 'complex_reasoning');
    expect(complex?.thinking).toEqual({ type: 'enabled', budgetTokens: 10_000 });
    expect(complex?.maxTokens).toBe(16_384);

    // doc_extraction — high budget
    const docExtract = routes.find((r) => r.taskType === 'doc_extraction');
    expect(docExtract?.thinking).toEqual({ type: 'enabled', budgetTokens: 8_000 });
    expect(docExtract?.maxTokens).toBe(12_288);
  });
});
