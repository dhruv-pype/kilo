import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from '@llm-gateway/providers/anthropic.js';
import type { ProviderRequest } from '@llm-gateway/types.js';

// ─── Helpers ─────────────────────────────────────────────────────

function baseRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'claude-sonnet-4-5-20250929',
    system: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    maxTokens: 8192,
    temperature: 0.7,
    ...overrides,
  };
}

function mockFetchResponse(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

// ─── Tests ───────────────────────────────────────────────────────

describe('AnthropicProvider — extended thinking', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider('test-key', 'https://api.anthropic.com');
    vi.restoreAllMocks();
  });

  it('includes thinking and omits temperature when thinking is enabled', async () => {
    const mockFetch = mockFetchResponse({
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-5-20250929',
    });
    vi.stubGlobal('fetch', mockFetch);

    await provider.complete(baseRequest({
      thinking: { type: 'enabled', budgetTokens: 5000 },
    }));

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 });
    expect(callBody.temperature).toBeUndefined();
  });

  it('includes temperature and omits thinking when thinking is not set', async () => {
    const mockFetch = mockFetchResponse({
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-5-20250929',
    });
    vi.stubGlobal('fetch', mockFetch);

    await provider.complete(baseRequest({ thinking: undefined }));

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.temperature).toBe(0.7);
    expect(callBody.thinking).toBeUndefined();
  });

  it('adds anthropic-beta header when thinking + tools are present', async () => {
    const mockFetch = mockFetchResponse({
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-5-20250929',
    });
    vi.stubGlobal('fetch', mockFetch);

    await provider.complete(baseRequest({
      thinking: { type: 'enabled', budgetTokens: 5000 },
      tools: [{ name: 'test_tool', description: 'A test tool', parameters: {} }],
    }));

    const callHeaders = mockFetch.mock.calls[0][1].headers;
    expect(callHeaders['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
  });

  it('does not add anthropic-beta header when thinking without tools', async () => {
    const mockFetch = mockFetchResponse({
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-5-20250929',
    });
    vi.stubGlobal('fetch', mockFetch);

    await provider.complete(baseRequest({
      thinking: { type: 'enabled', budgetTokens: 5000 },
      tools: [],
    }));

    const callHeaders = mockFetch.mock.calls[0][1].headers;
    expect(callHeaders['anthropic-beta']).toBeUndefined();
  });

  it('parses thinking blocks into thinkingSummary', async () => {
    const mockFetch = mockFetchResponse({
      content: [
        { type: 'thinking', thinking: 'Let me analyze this step by step...', signature: 'sig123' },
        { type: 'text', text: 'Here is my answer.' },
      ],
      usage: { input_tokens: 10, output_tokens: 50 },
      model: 'claude-sonnet-4-5-20250929',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await provider.complete(baseRequest({
      thinking: { type: 'enabled', budgetTokens: 5000 },
    }));

    expect(result.content).toBe('Here is my answer.');
    expect(result.thinkingSummary).toBe('Let me analyze this step by step...');
  });

  it('handles mixed content blocks: thinking + text + tool_use', async () => {
    const mockFetch = mockFetchResponse({
      content: [
        { type: 'thinking', thinking: 'Planning my approach...', signature: 'sig1' },
        { type: 'text', text: 'I will call the API.' },
        { type: 'tool_use', id: 'tu_1', name: 'call_api', input: { endpoint: '/users' } },
        { type: 'thinking', thinking: 'Processing the result...', signature: 'sig2' },
        { type: 'text', text: ' Here are the results.' },
      ],
      usage: { input_tokens: 20, output_tokens: 100 },
      model: 'claude-sonnet-4-5-20250929',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await provider.complete(baseRequest({
      thinking: { type: 'enabled', budgetTokens: 5000 },
      tools: [{ name: 'call_api', description: 'Call API', parameters: {} }],
    }));

    expect(result.content).toBe('I will call the API. Here are the results.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe('call_api');
    expect(result.thinkingSummary).toContain('Planning my approach...');
    expect(result.thinkingSummary).toContain('Processing the result...');
  });

  it('returns undefined thinkingSummary when no thinking blocks', async () => {
    const mockFetch = mockFetchResponse({
      content: [{ type: 'text', text: 'Plain response.' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-5-20250929',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await provider.complete(baseRequest());

    expect(result.thinkingSummary).toBeUndefined();
  });

  it('sends adaptive thinking type correctly', async () => {
    const mockFetch = mockFetchResponse({
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-opus-4-6',
    });
    vi.stubGlobal('fetch', mockFetch);

    await provider.complete(baseRequest({
      model: 'claude-opus-4-6',
      thinking: { type: 'adaptive' },
    }));

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.thinking).toEqual({ type: 'adaptive' });
    expect(callBody.temperature).toBeUndefined();
  });

  it('truncates long thinking summaries to 500 chars', async () => {
    const longThinking = 'A'.repeat(1000);
    const mockFetch = mockFetchResponse({
      content: [
        { type: 'thinking', thinking: longThinking, signature: 'sig' },
        { type: 'text', text: 'Done.' },
      ],
      usage: { input_tokens: 10, output_tokens: 500 },
      model: 'claude-sonnet-4-5-20250929',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await provider.complete(baseRequest({
      thinking: { type: 'enabled', budgetTokens: 5000 },
    }));

    expect(result.thinkingSummary).toHaveLength(500);
  });
});
