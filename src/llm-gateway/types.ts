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

export interface ProviderRequest {
  model: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  tools: ToolDefinition[];
  maxTokens: number;
  temperature: number;
}

export interface ProviderResponse {
  content: string;
  toolCalls: { toolName: string; arguments: Record<string, unknown> }[];
  usage: { promptTokens: number; completionTokens: number };
  model: string;
}

/**
 * Model routing configuration.
 * Maps task types to primary + fallback models.
 */
export interface ModelRoute {
  taskType: string;
  primary: { provider: string; model: string };
  fallback: { provider: string; model: string } | null;
}
