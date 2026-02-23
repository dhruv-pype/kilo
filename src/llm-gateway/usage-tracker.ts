import type { ModelPricing } from '../common/types/usage.js';
import * as usageRepo from '../database/repositories/usage-repository.js';
import { getCachedModelPricing, setCachedModelPricing } from '../cache/cache-service.js';

/**
 * Usage Tracker — calculates and logs LLM call costs.
 *
 * Design decisions:
 * - `calculateCost` is a pure function (no I/O) for easy testing
 * - `trackUsage` is fire-and-forget: it never blocks the chat response
 * - Pricing is cached in Redis (24hr TTL) to avoid DB lookups on every call
 * - Fallback pricing is hardcoded as a safety net if both cache and DB are down
 */

// ─── In-memory fallback pricing ─────────────────────────────────
// Used only when both Redis and Postgres are unreachable.
// Prevents usage tracking from silently dropping records.

const FALLBACK_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5-20251001': {
    model: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    inputCostPerMillionTokens: 0.80,
    outputCostPerMillionTokens: 4.00,
  },
  'claude-sonnet-4-5-20250929': {
    model: 'claude-sonnet-4-5-20250929',
    provider: 'anthropic',
    inputCostPerMillionTokens: 3.00,
    outputCostPerMillionTokens: 15.00,
  },
  'claude-opus-4-6': {
    model: 'claude-opus-4-6',
    provider: 'anthropic',
    inputCostPerMillionTokens: 15.00,
    outputCostPerMillionTokens: 75.00,
  },
  'gpt-4o-mini': {
    model: 'gpt-4o-mini',
    provider: 'openai',
    inputCostPerMillionTokens: 0.15,
    outputCostPerMillionTokens: 0.60,
  },
  'gpt-4o': {
    model: 'gpt-4o',
    provider: 'openai',
    inputCostPerMillionTokens: 2.50,
    outputCostPerMillionTokens: 10.00,
  },
};

// ─── Pure cost calculation ──────────────────────────────────────

/**
 * Calculate the cost of an LLM call in USD.
 * Pure function — no I/O, deterministic, easily testable.
 */
export function calculateCost(
  promptTokens: number,
  completionTokens: number,
  pricing: ModelPricing,
): number {
  const inputCost = (promptTokens / 1_000_000) * pricing.inputCostPerMillionTokens;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputCostPerMillionTokens;
  // Round to 6 decimal places to avoid floating-point artifacts
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

// ─── Context for attributing usage ──────────────────────────────

export interface UsageContext {
  userId: string;
  botId: string | null;
  sessionId: string | null;
  messageId: string | null;
}

// ─── Async tracking ─────────────────────────────────────────────

/**
 * Resolve pricing for a model. Tries Redis cache first, then DB, then fallback.
 */
async function resolvePricing(model: string): Promise<ModelPricing> {
  // 1. Try cache
  try {
    const cached = await getCachedModelPricing();
    if (cached) {
      const match = cached.find((p) => p.model === model);
      if (match) return match;
    }
  } catch {
    // Cache miss — continue to DB
  }

  // 2. Try database
  try {
    const dbPricing = await usageRepo.getModelPricing(model);
    if (dbPricing) {
      // Backfill cache with all pricing (batch, not per-model)
      const allPricing = await usageRepo.getAllModelPricing();
      await setCachedModelPricing(allPricing).catch(() => {});
      return dbPricing;
    }
  } catch {
    // DB error — fall through to hardcoded
  }

  // 3. Fallback to hardcoded pricing
  const fallback = FALLBACK_PRICING[model];
  if (fallback) return fallback;

  // 4. Unknown model — use a conservative default
  return {
    model,
    provider: 'unknown',
    inputCostPerMillionTokens: 5.00,
    outputCostPerMillionTokens: 15.00,
  };
}

/**
 * Track a single LLM call's usage. Called fire-and-forget after the LLM responds.
 * Never throws — all errors are caught and logged.
 */
export async function trackUsage(
  model: string,
  provider: string,
  promptTokens: number,
  completionTokens: number,
  latencyMs: number,
  taskType: string,
  context: UsageContext,
): Promise<void> {
  const pricing = await resolvePricing(model);
  const costUsd = calculateCost(promptTokens, completionTokens, pricing);

  await usageRepo.insertUsage({
    userId: context.userId,
    botId: context.botId,
    sessionId: context.sessionId,
    messageId: context.messageId,
    provider,
    model,
    taskType,
    promptTokens,
    completionTokens,
    costUsd,
    latencyMs,
  });
}
