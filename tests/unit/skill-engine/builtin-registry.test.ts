import { describe, it, expect } from 'vitest';
import {
  getBuiltInSkills,
  isBuiltInSkill,
  getBuiltInHandler,
} from '../../../src/skill-engine/builtin-skills/index.js';
import type { SkillDefinition } from '../../../src/common/types/skill.js';
import type { SkillId, BotId } from '../../../src/common/types/ids.js';

describe('Built-in Skill Registry', () => {
  it('returns 3 built-in skills', () => {
    const skills = getBuiltInSkills();
    expect(skills).toHaveLength(3);
  });

  it('all built-in skills have createdBy "system"', () => {
    const skills = getBuiltInSkills();
    for (const skill of skills) {
      expect(skill.createdBy).toBe('system');
    }
  });

  it('all built-in skills are active', () => {
    const skills = getBuiltInSkills();
    for (const skill of skills) {
      expect(skill.isActive).toBe(true);
    }
  });

  it('isBuiltInSkill returns true for system skills', () => {
    const skills = getBuiltInSkills();
    for (const skill of skills) {
      expect(isBuiltInSkill(skill)).toBe(true);
    }
  });

  it('isBuiltInSkill returns false for user skills', () => {
    const userSkill: SkillDefinition = {
      skillId: 'user-skill-1' as SkillId,
      botId: 'bot-1' as BotId,
      name: 'Custom Skill',
      description: 'A user skill',
      triggerPatterns: ['do something'],
      behaviorPrompt: 'Handle custom stuff',
      inputSchema: null,
      outputFormat: 'text',
      schedule: null,
      dataTable: null,
      readableTables: [],
      tableSchema: null,
      requiredIntegrations: [],
      createdBy: 'user_conversation',
      version: 1,
      performanceScore: 0.5,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(isBuiltInSkill(userSkill)).toBe(false);
  });

  it('getBuiltInHandler returns a handler for valid skillIds', () => {
    expect(getBuiltInHandler('builtin-time')).toBeTypeOf('function');
    expect(getBuiltInHandler('builtin-date-math')).toBeTypeOf('function');
    expect(getBuiltInHandler('builtin-random')).toBeTypeOf('function');
  });

  it('getBuiltInHandler returns null for unknown skillIds', () => {
    expect(getBuiltInHandler('nonexistent')).toBeNull();
    expect(getBuiltInHandler('user-skill-1')).toBeNull();
  });

  it('all skills have trigger patterns', () => {
    const skills = getBuiltInSkills();
    for (const skill of skills) {
      expect(skill.triggerPatterns.length).toBeGreaterThan(0);
    }
  });
});
