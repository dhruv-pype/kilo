import type { FastifyInstance } from 'fastify';
import * as botRepo from '../../database/repositories/bot-repository.js';
import type { BotCreateInput } from '../../common/types/bot.js';
import type { UserId } from '../../common/types/ids.js';

/**
 * Bot management routes.
 * CRUD for the user's bots. These are REST endpoints, not chat.
 */
export async function botRoutes(app: FastifyInstance): Promise<void> {

  // List user's bots
  app.get<{
    Querystring: { userId: string };
  }>('/api/bots', async (request) => {
    const { userId } = request.query;
    const bots = await botRepo.getBotsByUserId(userId);
    return { bots };
  });

  // Get a single bot
  app.get<{
    Params: { botId: string };
  }>('/api/bots/:botId', async (request) => {
    const bot = await botRepo.getBotById(request.params.botId);
    return { bot };
  });

  // Create a new bot
  app.post<{
    Body: BotCreateInput;
  }>('/api/bots', async (request, reply) => {
    const bot = await botRepo.createBot(request.body);
    reply.code(201);
    return { bot };
  });

  // Update a bot
  app.patch<{
    Params: { botId: string };
    Body: { name?: string; description?: string; personality?: string; context?: string };
  }>('/api/bots/:botId', async (request) => {
    const bot = await botRepo.updateBot(request.params.botId, request.body);
    return { bot };
  });

  // Delete a bot
  app.delete<{
    Params: { botId: string };
  }>('/api/bots/:botId', async (request, reply) => {
    await botRepo.deleteBot(request.params.botId);
    reply.code(204);
  });
}
