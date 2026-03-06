import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { botRoutes } from './routes/bot-routes.js';
import { skillRoutes } from './routes/skill-routes.js';
import { toolRoutes } from './routes/tool-routes.js';
import { chatRoutes } from './routes/chat-routes.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerAuth } from './middleware/auth.js';
import { extractBotId, extractBotIdFromResource, verifyBotOwnership } from './middleware/ownership.js';
import { CronScheduler } from '../scheduler/cron-scheduler.js';
import { MessageOrchestrator } from '../bot-runtime/orchestrator/message-orchestrator.js';
import type { DataLoaderPort } from '../bot-runtime/orchestrator/message-orchestrator.js';
import { LLMGateway, defaultModelRoutes } from '../llm-gateway/llm-gateway.js';
import { TrackedLLMGateway } from '../llm-gateway/tracked-llm-gateway.js';
import { usageRoutes } from './routes/usage-routes.js';
import { AnthropicProvider } from '../llm-gateway/providers/anthropic.js';
import { OpenAIProvider } from '../llm-gateway/providers/openai.js';
import { initPool, query } from '../database/pool.js';
import * as skillCreator from '../skill-engine/skill-creator.js';
import { initRedis } from '../cache/redis-client.js';
import { getCachedBotConfig, setCachedBotConfig, getCachedSkills, setCachedSkills, invalidateBotCache } from '../cache/cache-service.js';
import * as botRepo from '../database/repositories/bot-repository.js';
import * as skillRepo from '../database/repositories/skill-repository.js';
import * as messageRepo from '../database/repositories/message-repository.js';
import * as toolRepo from '../database/repositories/tool-registry-repository.js';
import * as memoryRepo from '../database/repositories/memory-repository.js';
import * as skillDataRepo from '../database/repositories/skill-data-repository.js';
import * as proposalRepo from '../database/repositories/skill-proposal-repository.js';
import * as refinementRepo from '../database/repositories/skill-refinement-repository.js';

// Augment Fastify so routes can access the scheduler
declare module 'fastify' {
  interface FastifyInstance {
    scheduler: CronScheduler;
  }
}

export interface ServerConfig {
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  anthropicApiKey: string;
  openaiApiKey: string;
  jwtSecret: string;
}

export async function createServer(config: ServerConfig) {
  const app = Fastify({ logger: true });

  // Plugins
  await app.register(cors, { origin: true });
  await app.register(helmet);

  // Auth — JWT verification on all /api/* routes
  await registerAuth(app, config.jwtSecret);

  // Ownership — verify userId owns the botId being accessed
  app.addHook('preHandler', async (request) => {
    if (request.url === '/health') return;
    if (!request.url.startsWith('/api/')) return;
    if (!request.userId) return;

    // Try direct botId from params/body first
    let botIdValue = extractBotId(request);

    // For /api/skills/:skillId or /api/tools/:toolId, look up the parent bot
    if (!botIdValue) {
      botIdValue = await extractBotIdFromResource(request);
    }

    if (botIdValue) {
      await verifyBotOwnership(request.userId as string, botIdValue);
    }
  });

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

    async loadMemoryFacts(botId, keyQuery) {
      return memoryRepo.getFactsByBotId(botId, keyQuery);
    },

    async loadRAGResults(_botId, _query) {
      // TODO: Vector search against Knowledge Store
      return [];
    },

    async loadSkillData(botId: string, tableName: string, dataQuery: string | null) {
      const bot = await botRepo.getBotById(botId);
      return skillDataRepo.loadSkillData(bot.schemaName, tableName, dataQuery);
    },

    async loadTableSchemas(botId: string, tableNames: string[]) {
      const bot = await botRepo.getBotById(botId);
      return skillDataRepo.loadTableSchemas(bot.schemaName, tableNames);
    },

    async loadRecentDismissals(botId) {
      return proposalRepo.getRecentDismissals(botId);
    },

    async loadProposal(proposalId) {
      return proposalRepo.getProposal(proposalId);
    },

    async createSkill(botId, input) {
      const [existingSkills, bot] = await Promise.all([
        skillRepo.getActiveSkillsByBotId(botId),
        botRepo.getBotById(botId),
      ]);
      const tierResult = await query<{ tier: string }>(
        'SELECT tier FROM users WHERE user_id = $1',
        [bot.userId as string],
      );
      const tier = tierResult.rows[0]?.tier ?? 'free';
      const result = await skillCreator.createSkill(input, existingSkills, tier);
      if (result.skill.schedule) {
        app.scheduler.registerJob(result.skill, bot.userId as string);
      }
    },

    async acceptProposal(proposalId) {
      await proposalRepo.updateProposalStatus(proposalId, 'accepted');
    },

    async dismissProposal(proposalId) {
      await proposalRepo.updateProposalStatus(proposalId, 'dismissed');
    },

    async updateSkill(skillId, updates) {
      const skill = await skillRepo.getSkillById(skillId);
      await skillRepo.updateSkill(skillId, updates);
      await invalidateBotCache(skill.botId as string);
    },

    async saveRefinement(skillId, botId, result) {
      return refinementRepo.saveRefinement(skillId, botId, result);
    },

    async loadRefinement(refinementId) {
      return refinementRepo.getRefinement(refinementId);
    },

    async applyRefinement(refinementId) {
      await refinementRepo.updateRefinementStatus(refinementId, 'applied');
    },

    async dismissRefinement(refinementId) {
      await refinementRepo.updateRefinementStatus(refinementId, 'dismissed');
    },

    async loadTools(botId: string, names: string[]) {
      return toolRepo.getToolsByNames(botId, names);
    },

    async querySkillData(schemaName: string, sql: string) {
      return skillDataRepo.executeSelectQuery(schemaName, sql);
    },
  };

  // Orchestrator — uses tracked gateway so every LLM call's cost is logged
  const orchestrator = new MessageOrchestrator(trackedGateway, dataLoader);

  // Scheduler — in-process cron job runner for scheduled skills
  const scheduler = new CronScheduler(orchestrator);
  app.decorate('scheduler', scheduler);

  // Routes
  await app.register(botRoutes);
  await app.register(skillRoutes);
  await app.register(toolRoutes);
  await app.register(usageRoutes);
  chatRoutes(app, orchestrator, trackedGateway);

  // Health check
  app.get('/health', async () => ({ status: 'ok' }));

  return { app, scheduler };
}
