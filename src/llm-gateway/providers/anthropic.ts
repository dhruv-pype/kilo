import type { LLMProvider, ProviderRequest, ProviderResponse } from '../types.js';
import { LLMError, LLMTimeoutError } from '../../common/errors/index.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Anthropic provider — calls the Claude API.
 * Uses the Messages API (https://docs.anthropic.com/claude/reference/messages_post)
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
    const body = {
      model: request.model,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      system: request.system,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      ...(request.tools.length > 0 ? {
        tools: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
      } : {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
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
        throw new LLMTimeoutError(this.name, request.model, DEFAULT_TIMEOUT_MS);
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
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

function mapAnthropicResponse(data: AnthropicResponse, requestModel: string): ProviderResponse {
  let content = '';
  const toolCalls: { toolName: string; arguments: Record<string, unknown> }[] = [];

  for (const block of data.content) {
    if (block.type === 'text') {
      content += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        toolName: block.name,
        arguments: block.input,
      });
    }
  }

  return {
    content,
    toolCalls,
    usage: {
      promptTokens: data.usage.input_tokens,
      completionTokens: data.usage.output_tokens,
    },
    model: data.model ?? requestModel,
  };
}
