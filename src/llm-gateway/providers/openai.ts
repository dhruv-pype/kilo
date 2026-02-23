import type { LLMProvider, ProviderRequest, ProviderResponse } from '../types.js';
import { LLMError, LLMTimeoutError } from '../../common/errors/index.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * OpenAI provider — calls the ChatCompletion API.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl: string = 'https://api.openai.com') {
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
      temperature: request.temperature,
      messages: [
        { role: 'system', content: request.system },
        ...request.messages,
      ],
    };

    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new LLMError(
          `OpenAI API error ${response.status}: ${errorBody}`,
          this.name,
          request.model,
        );
      }

      const data = await response.json() as OpenAIResponse;
      return mapOpenAIResponse(data, request.model);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new LLMTimeoutError(this.name, request.model, DEFAULT_TIMEOUT_MS);
      }
      if (err instanceof LLMError) throw err;
      throw new LLMError(
        `OpenAI request failed: ${(err as Error).message}`,
        this.name,
        request.model,
        err,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ─── OpenAI Response Mapping ───────────────────────────────────

interface OpenAIResponse {
  choices: {
    message: {
      content: string | null;
      tool_calls?: {
        function: { name: string; arguments: string };
      }[];
    };
  }[];
  usage: { prompt_tokens: number; completion_tokens: number };
  model: string;
}

function mapOpenAIResponse(data: OpenAIResponse, requestModel: string): ProviderResponse {
  const choice = data.choices[0];
  const content = choice?.message?.content ?? '';
  const toolCalls: { toolName: string; arguments: Record<string, unknown> }[] = [];

  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      try {
        toolCalls.push({
          toolName: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        });
      } catch {
        // Skip malformed tool call
      }
    }
  }

  return {
    content,
    toolCalls,
    usage: {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
    },
    model: data.model ?? requestModel,
  };
}
