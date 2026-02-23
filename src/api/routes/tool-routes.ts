import type { FastifyInstance } from 'fastify';
import * as toolRepo from '../../database/repositories/tool-registry-repository.js';
import type { ToolRegistryCreateInput, ToolRegistryUpdateInput } from '../../common/types/tool-registry.js';
import type { BotId } from '../../common/types/ids.js';

/**
 * Tool registry routes.
 * CRUD for external API integrations. Auth credentials are NEVER returned in responses.
 */
export async function toolRoutes(app: FastifyInstance): Promise<void> {

  // List tools for a bot (auth_config redacted)
  app.get<{
    Params: { botId: string };
  }>('/api/bots/:botId/tools', async (request) => {
    const tools = await toolRepo.getToolsByBotId(request.params.botId);
    return { tools };
  });

  // Get a single tool (auth_config redacted)
  app.get<{
    Params: { toolId: string };
  }>('/api/tools/:toolId', async (request) => {
    const tool = await toolRepo.getToolById(request.params.toolId);
    return { tool };
  });

  // Create a tool (encrypts credentials before storage)
  app.post<{
    Params: { botId: string };
    Body: Omit<ToolRegistryCreateInput, 'botId'>;
  }>('/api/bots/:botId/tools', async (request, reply) => {
    const tool = await toolRepo.createTool({
      ...request.body,
      botId: request.params.botId as BotId,
    });
    reply.code(201);
    return { tool };
  });

  // Update a tool
  app.patch<{
    Params: { toolId: string };
    Body: ToolRegistryUpdateInput;
  }>('/api/tools/:toolId', async (request) => {
    const tool = await toolRepo.updateTool(request.params.toolId, request.body);
    return { tool };
  });

  // Delete a tool
  app.delete<{
    Params: { toolId: string };
  }>('/api/tools/:toolId', async (request, reply) => {
    await toolRepo.deleteTool(request.params.toolId);
    reply.code(204);
  });
}
