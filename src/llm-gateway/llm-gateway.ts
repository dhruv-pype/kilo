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
 *   simple_qa        → cheapest model (Haiku-class), no thinking
 *   skill_execution  → mid-tier (Sonnet-class), thinking enabled (5k budget)
 *   skill_generation → mid-tier, thinking enabled (5k budget)
 *   complex_reasoning → strongest model (Opus-class), thinking enabled (10k budget)
 *   data_analysis    → mid-tier, thinking enabled (5k budget)
 *   doc_extraction   → mid-tier, thinking enabled (8k budget)
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
    // Primary request uses per-route thinking config and maxTokens
    const request = toProviderRequest(prompt, route.primary.model, route);

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

    // Try fallback — no thinking (graceful degradation to OpenAI etc.)
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

function toProviderRequest(prompt: Prompt, model: string, route?: ModelRoute): ProviderRequest {
  return {
    model,
    system: prompt.system,
    messages: prompt.messages,
    tools: prompt.tools,
    maxTokens: route?.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
    thinking: route?.thinking ?? undefined,
  };
}

function toLLMResponse(result: import('./types.js').ProviderResponse, latencyMs: number): LLMResponse {
  return {
    content: result.content,
    toolCalls: result.toolCalls,
    model: result.model,
    usage: result.usage,
    latencyMs,
    thinkingSummary: result.thinkingSummary,
  };
}

// ─── Default Routes ────────────────────────────────────────────

/**
 * Default model routing configuration.
 * Uses Anthropic as primary, OpenAI as fallback.
 *
 * Thinking budgets are tuned per task type:
 * - simple_qa: no thinking (wasteful for quick Q&A)
 * - skill_execution: moderate thinking (plan tool calls)
 * - skill_generation: moderate thinking (design good skill defs)
 * - complex_reasoning: high thinking (maximum reasoning depth)
 * - data_analysis: moderate thinking
 * - doc_extraction: high thinking (complex API doc analysis)
 */
export function defaultModelRoutes(): ModelRoute[] {
  return [
    {
      taskType: 'simple_qa',
      primary: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      fallback: { provider: 'openai', model: 'gpt-4o-mini' },
      // No thinking — fast and cheap
    },
    {
      taskType: 'skill_execution',
      primary: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
      fallback: { provider: 'openai', model: 'gpt-4o' },
      thinking: { type: 'enabled', budgetTokens: 5_000 },
      maxTokens: 8_192,
    },
    {
      taskType: 'skill_generation',
      primary: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
      fallback: { provider: 'openai', model: 'gpt-4o' },
      thinking: { type: 'enabled', budgetTokens: 5_000 },
      maxTokens: 8_192,
    },
    {
      taskType: 'complex_reasoning',
      primary: { provider: 'anthropic', model: 'claude-opus-4-6' },
      fallback: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
      thinking: { type: 'enabled', budgetTokens: 10_000 },
      maxTokens: 16_384,
    },
    {
      taskType: 'data_analysis',
      primary: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
      fallback: { provider: 'openai', model: 'gpt-4o' },
      thinking: { type: 'enabled', budgetTokens: 5_000 },
      maxTokens: 8_192,
    },
    {
      taskType: 'doc_extraction',
      primary: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
      fallback: { provider: 'openai', model: 'gpt-4o' },
      thinking: { type: 'enabled', budgetTokens: 8_000 },
      maxTokens: 12_288,
    },
  ];
}
