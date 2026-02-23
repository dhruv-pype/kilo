import type { BotId, UserId, UsageId, SessionId, MessageId } from './ids.js';

/**
 * LLM Usage & Cost Tracking types.
 *
 * Every LLM call gets logged as an LLMUsageRecord. The iOS app queries
 * aggregates via the usage API to show "You've spent $X.XX on AI."
 *
 * Cost is pre-calculated at write time using model_pricing. This means
 * SUM queries are fast, and pricing changes only affect future calls.
 */

// ─── Raw Record ─────────────────────────────────────────────────

export interface LLMUsageRecord {
  usageId: UsageId;
  userId: UserId;
  botId: BotId | null;
  sessionId: SessionId | null;
  messageId: MessageId | null;
  provider: string;
  model: string;
  taskType: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  createdAt: Date;
}

// ─── Aggregation Types ──────────────────────────────────────────

export interface UsageSummary {
  totalCostUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCalls: number;
}

export interface UsageBreakdown {
  groupKey: string;      // model name, bot ID, or date string
  totalCostUsd: number;
  totalTokens: number;
  callCount: number;
}

// ─── Query Parameters ───────────────────────────────────────────

export interface UsageQueryParams {
  userId: string;
  botId?: string;
  model?: string;
  startDate?: Date;
  endDate?: Date;
  groupBy?: 'model' | 'bot' | 'day' | 'month';
}

// ─── Model Pricing ──────────────────────────────────────────────

export interface ModelPricing {
  model: string;
  provider: string;
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
}
