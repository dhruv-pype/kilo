import type { Prompt, LLMResponse } from '../common/types/orchestrator.js';
import type { LLMProvider, ModelRoute, ProviderRequest } from './types.js';
import { LLMAllProvidersFailedError } from '../common/errors/index.js';
import type { LLMGatewayPort } from '../bot-runtime/orchestrator/message-orchestrator.js';

/**
 * LLM Gateway — Spec #2 interface implementation.
 *
 * Routes requests to the optimal LLM provider based on task type.
 * Handles failover: if the primary model fails, tries the fallback.
 *
 * Model routing strategy (from Spec #2):
 *   simple_qa        → cheapest model (Haiku-class)
 *   skill_execution  → mid-tier (Sonnet-class)
 *   skill_generation → mid-tier with strong instruction following
 *   complex_reasoning → strongest model (Opus-class)
 *   data_analysis    → mid-tier
 */

const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.7;

export class LLMGateway implements LLMGatewayPort {
  private readonly providers: Map<string, LLMProvider>;
  private readonly routes: ModelRoute[];

  constructor(providers: LLMProvider[], routes: ModelRoute[]) {
    this.providers = new Map(providers.map((p) => [p.name, p]));
    this.routes = routes;
  }

  async complete(
    prompt: Prompt,
    options: { taskType: string; streaming: boolean },
  ): Promise<LLMResponse> {
    const route = this.routes.find((r) => r.taskType === options.taskType);
    if (!route) {
      // Default to the first available route
      const fallbackRoute = this.routes[0];
      if (!fallbackRoute) {
        throw new LLMAllProvidersFailedError(options.taskType);
      }
      return this.tryRoute(prompt, fallbackRoute, options.taskType);
    }

    return this.tryRoute(prompt, route, options.taskType);
  }

  private async tryRoute(
    prompt: Prompt,
    route: ModelRoute,
    taskType: string,
  ): Promise<LLMResponse> {
    const request = toProviderRequest(prompt, route.primary.model);

    // Try primary
    const primaryProvider = this.providers.get(route.primary.provider);
    if (primaryProvider?.isAvailable()) {
      try {
        const startMs = Date.now();
        const result = await primaryProvider.complete(request);
        return toLLMResponse(result, Date.now() - startMs);
      } catch (err) {
        console.warn(
          `Primary LLM failed (${route.primary.provider}/${route.primary.model}):`,
          (err as Error).message,
        );
      }
    }

    // Try fallback
    if (route.fallback) {
      const fallbackProvider = this.providers.get(route.fallback.provider);
      if (fallbackProvider?.isAvailable()) {
        try {
          const fallbackRequest = toProviderRequest(prompt, route.fallback.model);
          const startMs = Date.now();
          const result = await fallbackProvider.complete(fallbackRequest);
          return toLLMResponse(result, Date.now() - startMs);
        } catch (err) {
          console.warn(
            `Fallback LLM failed (${route.fallback.provider}/${route.fallback.model}):`,
            (err as Error).message,
          );
        }
      }
    }

    throw new LLMAllProvidersFailedError(taskType);
  }
}

function toProviderRequest(prompt: Prompt, model: string): ProviderRequest {
  return {
    model,
    system: prompt.system,
    messages: prompt.messages,
    tools: prompt.tools,
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
  };
}

function toLLMResponse(result: import('./types.js').ProviderResponse, latencyMs: number): LLMResponse {
  return {
    content: result.content,
    toolCalls: result.toolCalls,
    model: result.model,
    usage: result.usage,
    latencyMs,
  };
}

// ─── Default Routes ────────────────────────────────────────────

/**
 * Default model routing configuration.
 * Uses Anthropic as primary, OpenAI as fallback.
 */
export function defaultModelRoutes(): ModelRoute[] {
  return [
    {
      taskType: 'simple_qa',
      primary: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      fallback: { provider: 'openai', model: 'gpt-4o-mini' },
    },
    {
      taskType: 'skill_execution',
      primary: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
      fallback: { provider: 'openai', model: 'gpt-4o' },
    },
    {
      taskType: 'skill_generation',
      primary: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
      fallback: { provider: 'openai', model: 'gpt-4o' },
    },
    {
      taskType: 'complex_reasoning',
      primary: { provider: 'anthropic', model: 'claude-opus-4-6' },
      fallback: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
    },
    {
      taskType: 'data_analysis',
      primary: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
      fallback: { provider: 'openai', model: 'gpt-4o' },
    },
  ];
}
