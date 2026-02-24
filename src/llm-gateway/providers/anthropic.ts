import type { LLMProvider, ProviderRequest, ProviderResponse } from '../types.js';
import { LLMError, LLMTimeoutError } from '../../common/errors/index.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const THINKING_TIMEOUT_MS = 60_000;
const THINKING_SUMMARY_MAX_CHARS = 500;

/**
 * Anthropic provider — calls the Claude API.
 * Uses the Messages API (https://docs.anthropic.com/claude/reference/messages_post)
 *
 * Supports extended thinking: when `request.thinking` is set, the provider
 * includes the `thinking` parameter, omits `temperature`, and parses
 * thinking blocks from the response.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl: string = 'https://api.anthropic.com') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    // Thinking and temperature are mutually exclusive (Anthropic constraint)
    if (request.thinking) {
      if (request.thinking.type === 'enabled') {
        body.thinking = { type: 'enabled', budget_tokens: request.thinking.budgetTokens };
      } else {
        body.thinking = { type: 'adaptive' };
      }
      // temperature MUST NOT be sent when thinking is enabled
    } else {
      body.temperature = request.temperature;
    }

    if (request.tools.length > 0) {
      body.tools = request.tools.map((t: { name: string; description: string; parameters: Record<string, unknown> }) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };

    // Interleaved thinking with tools requires a beta header
    if (request.thinking && request.tools.length > 0) {
      headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
    }

    // Thinking requests get a longer timeout
    const timeoutMs = request.thinking ? THINKING_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new LLMError(
          `Anthropic API error ${response.status}: ${errorBody}`,
          this.name,
          request.model,
        );
      }

      const data = await response.json() as AnthropicResponse;
      return mapAnthropicResponse(data, request.model);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new LLMTimeoutError(this.name, request.model, timeoutMs);
      }
      if (err instanceof LLMError) throw err;
      throw new LLMError(
        `Anthropic request failed: ${(err as Error).message}`,
        this.name,
        request.model,
        err,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ─── Anthropic Response Mapping ────────────────────────────────

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'thinking'; thinking: string; signature: string };

function mapAnthropicResponse(data: AnthropicResponse, requestModel: string): ProviderResponse {
  let content = '';
  const toolCalls: { toolName: string; arguments: Record<string, unknown> }[] = [];
  const thinkingBlocks: string[] = [];

  for (const block of data.content) {
    if (block.type === 'text') {
      content += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        toolName: block.name,
        arguments: block.input,
      });
    } else if (block.type === 'thinking') {
      thinkingBlocks.push(block.thinking);
    }
  }

  // Produce a summary from thinking blocks (capped for display)
  const thinkingSummary = thinkingBlocks.length > 0
    ? thinkingBlocks.join('\n').slice(0, THINKING_SUMMARY_MAX_CHARS)
    : undefined;

  return {
    content,
    toolCalls,
    usage: {
      promptTokens: data.usage.input_tokens,
      completionTokens: data.usage.output_tokens,
    },
    model: data.model ?? requestModel,
    thinkingSummary,
  };
}
