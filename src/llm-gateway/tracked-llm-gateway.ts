import type { LLMGatewayPort } from '../bot-runtime/orchestrator/message-orchestrator.js';
import type { Prompt, LLMResponse } from '../common/types/orchestrator.js';
import { trackUsage, type UsageContext } from './usage-tracker.js';

/**
 * TrackedLLMGateway — decorator pattern for usage tracking.
 *
 * Wraps any LLMGatewayPort and logs every call's cost to the database
 * AFTER the response is returned. Tracking is fire-and-forget:
 * failures are caught and logged but never surface to the caller.
 *
 * Why a decorator (not modifying LLMGateway directly):
 * - Open/closed principle: LLMGateway stays simple and untouched
 * - All existing tests pass without changes
 * - Easy to disable tracking (just don't wrap)
 * - Context (userId, botId) is set per-request from the API layer
 */
export class TrackedLLMGateway implements LLMGatewayPort {
  private currentContext: UsageContext | null = null;

  constructor(private readonly inner: LLMGatewayPort) {}

  /**
   * Set the attribution context for the next LLM call.
   * Called by chat-routes before each orchestrator.process().
   */
  setContext(context: UsageContext): void {
    this.currentContext = context;
  }

  async complete(
    prompt: Prompt,
    options: { taskType: string; streaming: boolean },
  ): Promise<LLMResponse> {
    const response = await this.inner.complete(prompt, options);

    // Fire-and-forget: log usage without blocking the response
    if (this.currentContext) {
      trackUsage(
        response.model,
        this.detectProvider(response.model),
        response.usage.promptTokens,
        response.usage.completionTokens,
        response.latencyMs,
        options.taskType,
        this.currentContext,
      ).catch((err) => {
        console.warn('[usage-tracker] Failed to log usage:', err);
      });
    }

    return response;
  }

  private detectProvider(model: string): string {
    if (model.startsWith('claude')) return 'anthropic';
    if (model.startsWith('gpt')) return 'openai';
    return 'unknown';
  }
}
