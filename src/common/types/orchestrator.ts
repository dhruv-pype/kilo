import type { BotId, SessionId, SkillId } from './ids.js';
import type { Message, UserMessage } from './message.js';
import type { SkillDefinition } from './skill.js';
import type { SoulDefinition } from './soul.js';
import type { ToolRegistryEntry } from './tool-registry.js';

// ─── Orchestrator ──────────────────────────────────────────────

export interface OrchestratorInput {
  message: UserMessage;
  botId: BotId;
  sessionId: SessionId;
}

export interface OrchestratorOutput {
  response: ProcessedResponse;
  sideEffects: SideEffect[];
}

// ─── SkillMatcher ──────────────────────────────────────────────

export interface SkillMatch {
  skill: SkillDefinition;
  confidence: number;
  contextRequirements: ContextRequirements;
  modelPreferences: ModelPreferences;
}

/**
 * Tells the Orchestrator exactly what data to load for this message.
 * This is the key to Spec #4's selective loading — a simple reminder
 * sets everything to false/minimal, while a data analysis query
 * requests full skill data and deep history.
 */
export interface ContextRequirements {
  needsConversationHistory: boolean;
  historyDepth: number;
  needsMemory: boolean;
  memoryQuery: string | null;
  needsRAG: boolean;
  ragQuery: string | null;
  needsSkillData: boolean;
  skillDataQuery: string | null;
}

// ─── PromptComposer ────────────────────────────────────────────

export interface CompositionInput {
  skill: SkillDefinition;
  message: UserMessage;
  conversationHistory: Message[];
  memoryContext: MemoryFact[];
  ragResults: RAGChunk[];
  skillData: SkillDataSnapshot;
  tableSchemas: TableSchema[];
  soul?: SoulDefinition | null;
  apiTools?: ToolRegistryEntry[];
}

export interface GeneralCompositionInput {
  message: UserMessage;
  conversationHistory: Message[];
  memoryContext: MemoryFact[];
  botConfig: { name: string; personality: string; context: string; soul?: SoulDefinition | null };
}

export interface Prompt {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  tools: ToolDefinition[];
}

// ─── LLM Gateway ───────────────────────────────────────────────

export type TaskType =
  | 'simple_qa'
  | 'skill_execution'
  | 'skill_generation'
  | 'complex_reasoning'
  | 'data_analysis';

export interface ModelPreferences {
  taskType: TaskType;
  maxLatencyMs?: number;
  maxTokens?: number;
  streaming: boolean;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  usage: { promptTokens: number; completionTokens: number };
  latencyMs: number;
}

// ─── SkillProposer ─────────────────────────────────────────────

export interface SkillProposal {
  proposedName: string;
  description: string;
  triggerExamples: string[];
  suggestedInputFields: FieldSuggestion[];
  suggestedSchedule: string | null;
  clarifyingQuestions: string[];
  confidence: number;
}

export interface FieldSuggestion {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

// ─── Response Processing ───────────────────────────────────────

export interface ProcessedResponse {
  content: string;
  format: 'text' | 'structured_card';
  structuredData: Record<string, unknown> | null;
  skillId: SkillId | null;
  suggestedActions: string[];
}

// ─── Side Effects ──────────────────────────────────────────────

export type SideEffect =
  | { type: 'memory_write'; facts: MemoryFact[] }
  | { type: 'skill_proposal'; proposal: SkillProposal }
  | { type: 'skill_data_write'; table: string; operation: 'insert' | 'update' | 'delete'; data: Record<string, unknown> }
  | { type: 'schedule_notification'; message: string; at: Date; recurring: string | null }
  | { type: 'analytics_event'; event: string; properties: Record<string, unknown> }
  | { type: 'api_call'; toolName: string; endpoint: string; status: number; latencyMs: number };

// ─── Supporting Types ──────────────────────────────────────────

export interface MemoryFact {
  key: string;
  value: string;
  source: 'user_stated' | 'inferred' | 'document';
  confidence: number;
  createdAt: Date;
}

export interface RAGChunk {
  content: string;
  documentId: string;
  relevanceScore: number;
}

export interface SkillDataSnapshot {
  tableName: string;
  rows: Record<string, unknown>[];
  totalCount: number;
}

export interface TableSchema {
  tableName: string;
  columns: { name: string; type: string; nullable: boolean }[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
}
