import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrackedLLMGateway } from '../../../src/llm-gateway/tracked-llm-gateway.js';
import type { LLMGatewayPort } from '../../../src/bot-runtime/orchestrator/message-orchestrator.js';
import type { Prompt, LLMResponse } from '../../../src/common/types/orchestrator.js';

/**
 * Tests for TrackedLLMGateway — the decorator that wraps LLMGatewayPort
 * to log usage after every call.
 *
 * Key behaviors to verify:
 * 1. It calls the inner gateway's complete() and returns its response unchanged
 * 2. It calls trackUsage after each call (fire-and-forget)
 * 3. If tracking fails, the LLM response still returns successfully
 * 4. Without context set, it still returns the LLM response (just no tracking)
 */

// Mock the usage tracker module so we don't hit the DB
vi.mock('../../../src/llm-gateway/usage-tracker.js', () => ({
  trackUsage: vi.fn().mockResolvedValue(undefined),
}));

import { trackUsage } from '../../../src/llm-gateway/usage-tracker.js';

const mockTrackUsage = vi.mocked(trackUsage);

function makeLLMResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: 'Hello!',
    toolCalls: [],
    model: 'claude-sonnet-4-5-20250929',
    usage: { promptTokens: 100, completionTokens: 50 },
    latencyMs: 200,
    ...overrides,
  };
}

function makePrompt(): Prompt {
  return {
    system: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Hi' }],
    tools: [],
  };
}

describe('TrackedLLMGateway', () => {
  let mockInner: LLMGatewayPort;
  let tracked: TrackedLLMGateway;
  const response = makeLLMResponse();

  beforeEach(() => {
    vi.clearAllMocks();
    mockInner = {
      complete: vi.fn().mockResolvedValue(response),
    };
    tracked = new TrackedLLMGateway(mockInner);
  });

  it('passes through the inner gateway response unchanged', async () => {
    tracked.setContext({ userId: 'u1', botId: 'b1', sessionId: 's1', messageId: 'm1' });

    const result = await tracked.complete(makePrompt(), {
      taskType: 'simple_qa',
      streaming: false,
    });

    expect(result).toBe(response);
    expect(mockInner.complete).toHaveBeenCalledOnce();
  });

  it('calls trackUsage with correct parameters after each call', async () => {
    tracked.setContext({ userId: 'u1', botId: 'b1', sessionId: 's1', messageId: 'm1' });

    await tracked.complete(makePrompt(), { taskType: 'skill_execution', streaming: false });

    // Wait for fire-and-forget to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(mockTrackUsage).toHaveBeenCalledWith(
      'claude-sonnet-4-5-20250929',  // model
      'anthropic',                     // detected provider
      100,                             // promptTokens
      50,                              // completionTokens
      200,                             // latencyMs
      'skill_execution',               // taskType
      { userId: 'u1', botId: 'b1', sessionId: 's1', messageId: 'm1' },
    );
  });

  it('detects OpenAI provider from model name', async () => {
    const gptResponse = makeLLMResponse({ model: 'gpt-4o' });
    (mockInner.complete as ReturnType<typeof vi.fn>).mockResolvedValue(gptResponse);
    tracked.setContext({ userId: 'u1', botId: 'b1', sessionId: null, messageId: null });

    await tracked.complete(makePrompt(), { taskType: 'simple_qa', streaming: false });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockTrackUsage).toHaveBeenCalledWith(
      'gpt-4o',
      'openai',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      'simple_qa',
      expect.any(Object),
    );
  });

  it('does not call trackUsage when no context is set', async () => {
    // Don't call setContext

    const result = await tracked.complete(makePrompt(), {
      taskType: 'simple_qa',
      streaming: false,
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(result).toBe(response);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('returns LLM response even if tracking fails', async () => {
    mockTrackUsage.mockRejectedValueOnce(new Error('DB connection lost'));
    tracked.setContext({ userId: 'u1', botId: 'b1', sessionId: 's1', messageId: 'm1' });

    // Should not throw
    const result = await tracked.complete(makePrompt(), {
      taskType: 'simple_qa',
      streaming: false,
    });

    expect(result).toBe(response);
  });

  it('propagates inner gateway errors', async () => {
    (mockInner.complete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LLM down'));
    tracked.setContext({ userId: 'u1', botId: 'b1', sessionId: 's1', messageId: 'm1' });

    await expect(
      tracked.complete(makePrompt(), { taskType: 'simple_qa', streaming: false }),
    ).rejects.toThrow('LLM down');
  });
});
