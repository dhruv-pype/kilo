import type { Prompt, LLMResponse, ToolDefinition } from '../common/types/orchestrator.js';

/**
 * Provider interface — every LLM provider implements this.
 * Adding a new provider (e.g., Mistral) means implementing this interface.
 */
export interface LLMProvider {
  readonly name: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  isAvailable(): boolean;
}

// ─── Extended Thinking ──────────────────────────────────────────

/**
 * Thinking configuration for Anthropic extended thinking.
 *
 * - `enabled`: Model reasons internally before responding. budget_tokens
 *   controls how many tokens are allocated (min 1024, must be < maxTokens).
 * - `adaptive`: Model decides how much thinking to use (Opus 4.6+ only).
 * - `null`: No thinking (default).
 *
 * Constraints when thinking is enabled:
 * - Temperature MUST NOT be sent (Anthropic rejects it).
 * - tool_choice can only be "auto" or "none" (no forced tools).
 */
export type ThinkingConfig =
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'adaptive' }
  | null;

// ─── Provider Request / Response ────────────────────────────────

export interface ProviderRequest {
  model: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  tools: ToolDefinition[];
  maxTokens: number;
  temperature: number;
  thinking?: ThinkingConfig;
}

export interface ProviderResponse {
  content: string;
  toolCalls: { toolName: string; arguments: Record<string, unknown> }[];
  usage: { promptTokens: number; completionTokens: number };
  model: string;
  thinkingSummary?: string;
}

/**
 * Model routing configuration.
 * Maps task types to primary + fallback models.
 *
 * Optional `thinking` and `maxTokens` allow per-task configuration.
 * When thinking is enabled, the gateway will omit temperature from the
 * provider request and use the specified maxTokens.
 */
export interface ModelRoute {
  taskType: string;
  primary: { provider: string; model: string };
  fallback: { provider: string; model: string } | null;
  thinking?: ThinkingConfig;
  maxTokens?: number;
}
