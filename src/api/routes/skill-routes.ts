import type { FastifyInstance } from 'fastify';
import * as skillRepo from '../../database/repositories/skill-repository.js';
import * as skillCreator from '../../skill-engine/skill-creator.js';
import { validateSkill } from '../../skill-engine/skill-validator.js';
import type { SkillCreateInput } from '../../common/types/skill.js';

/**
 * Skill management routes.
 * CRUD + validation for bot skills.
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
    Body: SkillCreateInput & { userTier?: string };
  }>('/api/bots/:botId/skills', async (request, reply) => {
    const existingSkills = await skillRepo.getActiveSkillsByBotId(request.params.botId);
    const userTier = request.body.userTier ?? 'free';

    const result = await skillCreator.createSkill(request.body, existingSkills, userTier);
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
    return { skill };
  });

  // Delete a skill
  app.delete<{
    Params: { botId: string; skillId: string };
  }>('/api/bots/:botId/skills/:skillId', async (request, reply) => {
    await skillCreator.deleteSkill(request.params.skillId, request.params.botId);
    reply.code(204);
  });
}
