/**
 * Web Research types — Phase 3.
 *
 * These types support the learning flow: detecting when a user wants
 * the bot to learn a new API integration, searching for documentation,
 * parsing it, and producing tool + skill proposals.
 */

import type { BotId } from '../common/types/ids.js';
import type { ToolEndpoint, AuthType } from '../common/types/tool-registry.js';

// ─── Search ───────────────────────────────────────────────────────

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  isApiDoc: boolean;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  query: string;
}

// ─── Page Fetching ────────────────────────────────────────────────

export interface FetchedPage {
  url: string;
  title: string;
  textContent: string;
  codeBlocks: string[];
  truncated: boolean;
  fetchedAt: Date;
}

// ─── Doc Analysis (LLM output) ───────────────────────────────────

export interface ExtractedApiInfo {
  serviceName: string;
  baseUrl: string;
  authType: AuthType;
  authInstructions: string;
  endpoints: ExtractedEndpoint[];
  rateLimits: string | null;
  confidence: number;
}

export interface ExtractedEndpoint {
  path: string;
  method: string;
  description: string;
  parameters: Record<string, unknown>;
  responseSchema: Record<string, unknown> | null;
}

// ─── Learning Proposal ───────────────────────────────────────────

export interface LearningProposal {
  serviceName: string;
  toolProposal: ToolProposal;
  skillProposals: SkillProposalFromLearning[];
  authInstructions: string;
  sourceUrls: string[];
  confidence: number;
}

export interface ToolProposal {
  name: string;
  description: string;
  baseUrl: string;
  authType: AuthType;
  endpoints: ToolEndpoint[];
}

export interface SkillProposalFromLearning {
  name: string;
  description: string;
  triggerPatterns: string[];
  behaviorPrompt: string;
  requiredIntegrations: string[];
  outputFormat: 'text' | 'structured_card';
}

// ─── Learning Flow State ─────────────────────────────────────────

export type LearningStage =
  | 'searching'
  | 'fetching'
  | 'analyzing'
  | 'proposing'
  | 'complete'
  | 'failed';

export interface LearningFlowInput {
  botId: BotId;
  userMessage: string;
  serviceName: string;
}

export interface LearningFlowOutput {
  proposal: LearningProposal;
  progressLog: LearningProgressEntry[];
}

export interface LearningProgressEntry {
  stage: LearningStage;
  message: string;
  timestamp: Date;
}

// ─── Learning Intent Detection ───────────────────────────────────

export interface LearningIntent {
  serviceName: string;
  confidence: number;
  originalPhrase: string;
}
