/**
 * Ownership verification middleware.
 *
 * After JWT auth extracts userId, this guard ensures the user
 * actually owns the bot (or the resource's parent bot) they're
 * trying to access. Prevents cross-tenant access even without RLS.
 */

import type { FastifyRequest } from 'fastify';
import { AuthorizationError } from '../../common/errors/index.js';
import * as botRepo from '../../database/repositories/bot-repository.js';
import * as skillRepo from '../../database/repositories/skill-repository.js';
import * as toolRepo from '../../database/repositories/tool-registry-repository.js';

/**
 * Extract botId from the request regardless of where it appears:
 * - Params: /api/bots/:botId/skills
 * - Body:   POST /api/chat { botId: "..." }
 *
 * Returns null if no botId is found (e.g. GET /api/bots lists user's own bots).
 */
export function extractBotId(request: FastifyRequest): string | null {
  const params = request.params as Record<string, string>;
  if (params?.botId) return params.botId;

  const body = request.body as Record<string, unknown> | undefined;
  if (body?.botId && typeof body.botId === 'string') return body.botId;

  return null;
}

/**
 * For routes like /api/skills/:skillId or /api/tools/:toolId that don't
 * include botId in params, look up the resource to find its parent botId.
 */
export async function extractBotIdFromResource(request: FastifyRequest): Promise<string | null> {
  const params = request.params as Record<string, string>;

  // GET/PATCH/DELETE /api/skills/:skillId
  if (params?.skillId && !params?.botId) {
    const skill = await skillRepo.getSkillById(params.skillId);
    return skill.botId as string;
  }

  // GET/PATCH/DELETE /api/tools/:toolId
  if (params?.toolId && !params?.botId) {
    const tool = await toolRepo.getToolById(params.toolId);
    return tool.botId as string;
  }

  return null;
}

/**
 * Verify that the authenticated userId owns the given botId.
 * Throws AuthorizationError (403) if not.
 */
export async function verifyBotOwnership(userId: string, botId: string): Promise<void> {
  const bot = await botRepo.getBotById(botId);
  if ((bot.userId as string) !== userId) {
    throw new AuthorizationError('You do not own this bot');
  }
}
