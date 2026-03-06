import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SkillDefinition } from '@common/types/skill.js';
import type { BotId, SkillId } from '@common/types/ids.js';

// Mock node-cron
const mockSchedule = vi.fn();
const mockValidate = vi.fn();
vi.mock('node-cron', () => ({
  default: {
    schedule: (...args: unknown[]) => mockSchedule(...args),
    validate: (...args: unknown[]) => mockValidate(...args),
  },
}));

// Mock skill repository
vi.mock('@database/repositories/skill-repository.js', () => ({
  getScheduledSkills: vi.fn(),
}));

// Mock memory repository
vi.mock('@database/repositories/memory-repository.js', () => ({
  upsertFacts: vi.fn(),
}));

// Mock bot repository
vi.mock('@database/repositories/bot-repository.js', () => ({
  getBotById: vi.fn(),
}));

// Mock soul evolver
vi.mock('@bot-runtime/soul-evolver/soul-evolver.js', () => ({
  applySoulPatches: vi.fn(),
}));

// Mock cache
vi.mock('@cache/cache-service.js', () => ({
  invalidateBotCache: vi.fn(),
}));

// Mock request context
const mockEnterWith = vi.fn();
vi.mock('@database/request-context.js', () => ({
  requestContext: {
    enterWith: (...args: unknown[]) => mockEnterWith(...args),
  },
}));

import * as skillRepo from '@database/repositories/skill-repository.js';
import { CronScheduler } from '@scheduler/cron-scheduler.js';

function makeSkill(name: string, schedule: string | null): SkillDefinition {
  return {
    skillId: `skill-${name}` as SkillId,
    botId: 'bot-123' as BotId,
    name,
    description: `${name} skill`,
    triggerPatterns: [name],
    behaviorPrompt: `Handle ${name}`,
    inputSchema: null,
    outputFormat: 'text',
    schedule,
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
}

function makeMockOrchestrator() {
  return {
    process: vi.fn().mockResolvedValue({
      response: { content: 'Scheduled response', format: 'text', structuredData: null, skillId: null, suggestedActions: [] },
      sideEffects: [],
    }),
  } as any;
}

describe('CronScheduler', () => {
  let scheduler: CronScheduler;
  let orchestrator: ReturnType<typeof makeMockOrchestrator>;
  let mockTask: { stop: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = makeMockOrchestrator();
    scheduler = new CronScheduler(orchestrator);

    mockTask = { stop: vi.fn() };
    mockSchedule.mockReturnValue(mockTask);
    mockValidate.mockReturnValue(true);
  });

  describe('registerJob', () => {
    it('registers a cron job for a scheduled skill', () => {
      const skill = makeSkill('reminder', '0 9 * * *');
      scheduler.registerJob(skill, 'user-abc');

      expect(mockValidate).toHaveBeenCalledWith('0 9 * * *');
      expect(mockSchedule).toHaveBeenCalledWith('0 9 * * *', expect.any(Function));
      expect(scheduler.jobCount).toBe(1);
    });

    it('skips registration when schedule is null', () => {
      const skill = makeSkill('no-schedule', null);
      scheduler.registerJob(skill, 'user-abc');

      expect(mockSchedule).not.toHaveBeenCalled();
      expect(scheduler.jobCount).toBe(0);
    });

    it('skips registration for invalid cron expressions', () => {
      mockValidate.mockReturnValue(false);
      const skill = makeSkill('bad-cron', 'not a cron');
      scheduler.registerJob(skill, 'user-abc');

      expect(mockSchedule).not.toHaveBeenCalled();
      expect(scheduler.jobCount).toBe(0);
    });

    it('replaces existing job when re-registering', () => {
      const skill = makeSkill('reminder', '0 9 * * *');
      scheduler.registerJob(skill, 'user-abc');
      expect(scheduler.jobCount).toBe(1);

      // Re-register with updated schedule
      const updatedSkill = makeSkill('reminder', '0 18 * * *');
      scheduler.registerJob(updatedSkill, 'user-abc');

      expect(mockTask.stop).toHaveBeenCalledOnce();
      expect(scheduler.jobCount).toBe(1);
    });
  });

  describe('removeJob', () => {
    it('stops and removes a registered job', () => {
      const skill = makeSkill('reminder', '0 9 * * *');
      scheduler.registerJob(skill, 'user-abc');
      expect(scheduler.jobCount).toBe(1);

      scheduler.removeJob('skill-reminder');
      expect(mockTask.stop).toHaveBeenCalledOnce();
      expect(scheduler.jobCount).toBe(0);
    });

    it('does nothing for non-existent job', () => {
      scheduler.removeJob('skill-nonexistent');
      expect(scheduler.jobCount).toBe(0);
    });
  });

  describe('stopAll', () => {
    it('stops all registered jobs', () => {
      const task1 = { stop: vi.fn() };
      const task2 = { stop: vi.fn() };
      mockSchedule.mockReturnValueOnce(task1).mockReturnValueOnce(task2);

      scheduler.registerJob(makeSkill('a', '0 9 * * *'), 'user-1');
      scheduler.registerJob(makeSkill('b', '0 18 * * *'), 'user-2');
      expect(scheduler.jobCount).toBe(2);

      scheduler.stopAll();
      expect(task1.stop).toHaveBeenCalled();
      expect(task2.stop).toHaveBeenCalled();
      expect(scheduler.jobCount).toBe(0);
    });
  });

  describe('initialize', () => {
    it('loads scheduled skills and registers jobs', async () => {
      const skills = [
        { ...makeSkill('daily', '0 9 * * *'), userId: 'user-1' },
        { ...makeSkill('hourly', '0 * * * *'), userId: 'user-2' },
      ];
      vi.mocked(skillRepo.getScheduledSkills).mockResolvedValue(skills);

      await scheduler.initialize();

      expect(skillRepo.getScheduledSkills).toHaveBeenCalledOnce();
      expect(mockSchedule).toHaveBeenCalledTimes(2);
      expect(scheduler.jobCount).toBe(2);
    });

    it('handles errors gracefully', async () => {
      vi.mocked(skillRepo.getScheduledSkills).mockRejectedValue(new Error('DB down'));

      await scheduler.initialize();

      // Should not throw
      expect(scheduler.jobCount).toBe(0);
    });
  });

  describe('executeScheduledSkill', () => {
    it('sets RLS context for the owning user', async () => {
      const skill = makeSkill('reminder', '0 9 * * *');
      await scheduler.executeScheduledSkill(skill, 'user-abc');

      expect(mockEnterWith).toHaveBeenCalledWith({ userId: 'user-abc' });
    });

    it('calls orchestrator with synthetic message', async () => {
      const skill = makeSkill('briefing', '0 9 * * *');
      await scheduler.executeScheduledSkill(skill, 'user-xyz');

      expect(orchestrator.process).toHaveBeenCalledOnce();
      const call = orchestrator.process.mock.calls[0][0];
      expect(call.message.content).toContain('[Scheduled execution]');
      expect(call.message.content).toContain('briefing');
      expect(call.botId).toBe('bot-123');
    });

    it('handles orchestrator errors gracefully', async () => {
      orchestrator.process.mockRejectedValue(new Error('LLM timeout'));
      const skill = makeSkill('broken', '0 9 * * *');

      // Should not throw
      await scheduler.executeScheduledSkill(skill, 'user-abc');
    });
  });
});
