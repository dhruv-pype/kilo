import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { botRoutes } from './routes/bot-routes.js';
import { skillRoutes } from './routes/skill-routes.js';
import { toolRoutes } from './routes/tool-routes.js';
import { chatRoutes } from './routes/chat-routes.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { MessageOrchestrator } from '../bot-runtime/orchestrator/message-orchestrator.js';
import type { DataLoaderPort } from '../bot-runtime/orchestrator/message-orchestrator.js';
import { LLMGateway, defaultModelRoutes } from '../llm-gateway/llm-gateway.js';
import { TrackedLLMGateway } from '../llm-gateway/tracked-llm-gateway.js';
import { usageRoutes } from './routes/usage-routes.js';
import { AnthropicProvider } from '../llm-gateway/providers/anthropic.js';
import { OpenAIProvider } from '../llm-gateway/providers/openai.js';
import { initPool } from '../database/pool.js';
import { initRedis } from '../cache/redis-client.js';
import { getCachedBotConfig, setCachedBotConfig, getCachedSkills, setCachedSkills } from '../cache/cache-service.js';
import * as botRepo from '../database/repositories/bot-repository.js';
import * as skillRepo from '../database/repositories/skill-repository.js';
import * as messageRepo from '../database/repositories/message-repository.js';
import * as toolRepo from '../database/repositories/tool-registry-repository.js';

export interface ServerConfig {
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  anthropicApiKey: string;
  openaiApiKey: string;
}

export async function createServer(config: ServerConfig) {
  const app = Fastify({ logger: true });

  // Plugins
  await app.register(cors, { origin: true });
  await app.register(helmet);

  // Error handler
  registerErrorHandler(app);

  // Infrastructure
  initPool(config.databaseUrl);
  initRedis(config.redisUrl);

  // LLM providers
  const providers = [
    new AnthropicProvider(config.anthropicApiKey),
    new OpenAIProvider(config.openaiApiKey),
  ].filter((p) => p.isAvailable());

  const llmGateway = new LLMGateway(providers, defaultModelRoutes());

  // Wrap LLM Gateway with usage tracking decorator
  const trackedGateway = new TrackedLLMGateway(llmGateway);

  // Data loader — bridges the Orchestrator to actual data sources.
  // Uses cache-first strategy (Spec #4).
  const dataLoader: DataLoaderPort = {
    async loadBotConfig(botId: string) {
      const cached = await getCachedBotConfig(botId);
      if (cached) return cached;
      const config = await botRepo.getBotById(botId);
      await setCachedBotConfig(botId, config);
      return config;
    },

    async loadSkills(botId: string) {
      const cached = await getCachedSkills(botId);
      if (cached) return cached;
      const skills = await skillRepo.getActiveSkillsByBotId(botId);
      await setCachedSkills(botId, skills);
      return skills;
    },

    async loadConversationHistory(botId, sessionId, depth) {
      return messageRepo.getRecentMessages(botId, sessionId, depth);
    },

    async loadMemoryFacts(_botId, _query) {
      // TODO: Query memory_facts table (basic) or vector search (semantic)
      return [];
    },

    async loadRAGResults(_botId, _query) {
      // TODO: Vector search against Knowledge Store
      return [];
    },

    async loadSkillData(_botId, _tableName, _query) {
      // TODO: Query skill data via data-executor
      return { tableName: '', rows: [], totalCount: 0 };
    },

    async loadTableSchemas(_botId, _tableNames) {
      // TODO: Load from cache or information_schema
      return [];
    },

    async loadRecentDismissals(_botId) {
      // TODO: Query skill_proposals table
      return [];
    },

    async loadTools(botId: string, names: string[]) {
      return toolRepo.getToolsByNames(botId, names);
    },
  };

  // Orchestrator — uses tracked gateway so every LLM call's cost is logged
  const orchestrator = new MessageOrchestrator(trackedGateway, dataLoader);

  // Routes
  await app.register(botRoutes);
  await app.register(skillRoutes);
  await app.register(toolRoutes);
  await app.register(usageRoutes);
  chatRoutes(app, orchestrator, trackedGateway);

  // Health check
  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
