/**
 * In-process cron scheduler for Kilo.
 *
 * On server startup, loads all skills with a `schedule` cron expression
 * and registers node-cron jobs for each. When a job fires, it executes
 * the skill through the orchestrator with a synthetic message.
 *
 * Privacy guarantee: each scheduled execution calls
 * `requestContext.enterWith({ userId })` before the orchestrator call,
 * so all DB queries go through Postgres RLS with the owning user's ID.
 * User A's scheduled job cannot touch User B's data.
 *
 * Jobs are re-registered when skills are created/updated/deleted via the API.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import type { MessageOrchestrator } from '../bot-runtime/orchestrator/message-orchestrator.js';
import type { SkillDefinition } from '../common/types/skill.js';
import type { Attachment } from '../common/types/message.js';
import { messageId, sessionId, userId as toUserId } from '../common/types/ids.js';
import type { BotId } from '../common/types/ids.js';
import { requestContext } from '../database/request-context.js';
import * as skillRepo from '../database/repositories/skill-repository.js';
import * as memoryRepo from '../database/repositories/memory-repository.js';
import * as botRepo from '../database/repositories/bot-repository.js';
import { applySoulPatches } from '../bot-runtime/soul-evolver/soul-evolver.js';
import { invalidateBotCache } from '../cache/cache-service.js';

interface ScheduledJob {
  skillId: string;
  botId: string;
  userId: string;
  schedule: string;
  task: ScheduledTask;
}

export class CronScheduler {
  private jobs: Map<string, ScheduledJob> = new Map();

  constructor(private readonly orchestrator: MessageOrchestrator) {}

  /**
   * Load all scheduled skills from the database and register cron jobs.
   * Called once on server startup, after the server is listening.
   */
  async initialize(): Promise<void> {
    try {
      const scheduledSkills = await skillRepo.getScheduledSkills();
      console.log(`[scheduler] Found ${scheduledSkills.length} scheduled skill(s)`);

      for (const skill of scheduledSkills) {
        this.registerJob(skill, skill.userId);
      }
    } catch (err) {
      console.error('[scheduler] Failed to initialize:', (err as Error).message);
    }
  }

  /**
   * Register a single cron job for a skill.
   * If a job for this skill already exists, it is replaced.
   */
  registerJob(skill: SkillDefinition, ownerUserId: string): void {
    const key = skill.skillId as string;

    // Remove existing job if re-registering
    this.removeJob(key);

    if (!skill.schedule) return;

    if (!cron.validate(skill.schedule)) {
      console.warn(`[scheduler] Invalid cron for skill ${skill.name} (${key}): ${skill.schedule}`);
      return;
    }

    const task = cron.schedule(skill.schedule, () => {
      // Fire-and-forget — errors are caught inside executeScheduledSkill
      this.executeScheduledSkill(skill, ownerUserId);
    });

    this.jobs.set(key, {
      skillId: key,
      botId: skill.botId as string,
      userId: ownerUserId,
      schedule: skill.schedule,
      task,
    });

    console.log(`[scheduler] Registered: ${skill.name} [${skill.schedule}]`);
  }

  /**
   * Remove a cron job by skill ID.
   */
  removeJob(skillId: string): void {
    const existing = this.jobs.get(skillId);
    if (existing) {
      existing.task.stop();
      this.jobs.delete(skillId);
      console.log(`[scheduler] Removed job: ${skillId}`);
    }
  }

  /**
   * Execute a scheduled skill through the orchestrator.
   * Creates a synthetic message and runs in the owning user's RLS context.
   */
  async executeScheduledSkill(
    skill: SkillDefinition,
    ownerUserId: string,
  ): Promise<void> {
    try {
      // Set the RLS context so all DB queries during execution
      // are scoped to the owning user's data
      requestContext.enterWith({ userId: ownerUserId });

      const syntheticMessage = {
        messageId: messageId(uuidv4()),
        sessionId: sessionId(`scheduled-${skill.skillId}`),
        botId: skill.botId as BotId,
        userId: toUserId(ownerUserId),
        content: `[Scheduled execution] ${skill.name}: ${skill.description}`,
        attachments: [] as Attachment[],
        timestamp: new Date(),
      };

      console.log(`[scheduler] Firing: ${skill.name} (${skill.skillId})`);

      const result = await this.orchestrator.process({
        message: syntheticMessage,
        botId: skill.botId as BotId,
        sessionId: syntheticMessage.sessionId,
      });

      console.log(`[scheduler] Completed: ${skill.name} → ${result.response.content.slice(0, 100)}`);

      // Process side effects in the user's RLS context
      for (const effect of result.sideEffects) {
        try {
          if (effect.type === 'memory_write') {
            await memoryRepo.upsertFacts(skill.botId as string, effect.facts);
          } else if (effect.type === 'soul_update') {
            const bot = await botRepo.getBotById(effect.botId);
            if (bot.soul) {
              const updatedSoul = applySoulPatches(bot.soul, effect.patches);
              await botRepo.updateBot(effect.botId, { soul: updatedSoul });
              await invalidateBotCache(effect.botId);
            }
          }
        } catch (effectErr) {
          console.error(`[scheduler] Side effect error in ${skill.name}:`, (effectErr as Error).message);
        }
      }
    } catch (err) {
      console.error(`[scheduler] Error executing ${skill.name}:`, (err as Error).message);
    }
  }

  /**
   * Stop all cron jobs. Called on server shutdown.
   */
  stopAll(): void {
    for (const [, job] of this.jobs) {
      job.task.stop();
    }
    const count = this.jobs.size;
    this.jobs.clear();
    console.log(`[scheduler] Stopped ${count} job(s)`);
  }

  /**
   * Get current job count (for health checks / diagnostics).
   */
  get jobCount(): number {
    return this.jobs.size;
  }
}
