import type { FastifyInstance } from 'fastify';
import * as skillRepo from '../../database/repositories/skill-repository.js';
import * as skillCreator from '../../skill-engine/skill-creator.js';
import * as botRepo from '../../database/repositories/bot-repository.js';
import { validateSkill } from '../../skill-engine/skill-validator.js';
import { query } from '../../database/pool.js';
import type { SkillCreateInput } from '../../common/types/skill.js';

/**
 * Skill management routes.
 * CRUD + validation for bot skills.
 *
 * When skills with a cron schedule are created/updated/deleted,
 * the scheduler is notified to register/remove cron jobs.
 */
export async function skillRoutes(app: FastifyInstance): Promise<void> {

  // List skills for a bot
  app.get<{
    Params: { botId: string };
  }>('/api/bots/:botId/skills', async (request) => {
    const skills = await skillRepo.getActiveSkillsByBotId(request.params.botId);
    return { skills };
  });

  // Get a single skill
  app.get<{
    Params: { skillId: string };
  }>('/api/skills/:skillId', async (request) => {
    const skill = await skillRepo.getSkillById(request.params.skillId);
    return { skill };
  });

  // Validate a skill (dry check, does not create)
  app.post<{
    Params: { botId: string };
    Body: SkillCreateInput;
  }>('/api/bots/:botId/skills/validate', async (request) => {
    const existingSkills = await skillRepo.getActiveSkillsByBotId(request.params.botId);
    const result = validateSkill(request.body, existingSkills);
    return { validation: result };
  });

  // Create a skill (validates first)
  app.post<{
    Params: { botId: string };
    Body: SkillCreateInput;
  }>('/api/bots/:botId/skills', async (request, reply) => {
    const [existingSkills, bot] = await Promise.all([
      skillRepo.getActiveSkillsByBotId(request.params.botId),
      botRepo.getBotById(request.params.botId),
    ]);

    // Read tier from DB — never trust the client for authorization decisions
    const tierResult = await query<{ tier: string }>(
      'SELECT tier FROM users WHERE user_id = $1',
      [bot.userId as string],
    );
    const userTier = tierResult.rows[0]?.tier ?? 'free';

    const result = await skillCreator.createSkill(request.body, existingSkills, userTier);

    // Register cron job if the skill has a schedule
    if (result.skill.schedule) {
      app.scheduler.registerJob(result.skill, request.userId as string);
    }

    reply.code(201);
    return { skill: result.skill, tableCreated: result.tableCreated };
  });

  // Update a skill
  app.patch<{
    Params: { skillId: string };
    Body: {
      name?: string;
      description?: string;
      triggerPatterns?: string[];
      behaviorPrompt?: string;
      isActive?: boolean;
    };
  }>('/api/skills/:skillId', async (request) => {
    const skill = await skillRepo.updateSkill(request.params.skillId, request.body);

    // Re-register or remove the cron job based on updated schedule
    if (skill.schedule) {
      const bot = await botRepo.getBotById(skill.botId as string);
      app.scheduler.registerJob(skill, bot.userId as string);
    } else {
      app.scheduler.removeJob(request.params.skillId);
    }

    return { skill };
  });

  // Delete a skill
  app.delete<{
    Params: { botId: string; skillId: string };
  }>('/api/bots/:botId/skills/:skillId', async (request, reply) => {
    // Remove cron job before deleting the skill
    app.scheduler.removeJob(request.params.skillId);

    await skillCreator.deleteSkill(request.params.skillId, request.params.botId);
    reply.code(204);
  });
}
