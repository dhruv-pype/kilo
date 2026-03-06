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
import * as messageRepo from '../database/repositories/message-repository.js';
import * as notificationRepo from '../database/repositories/notification-repository.js';
import { applySoulPatches } from '../bot-runtime/soul-evolver/soul-evolver.js';
import { invalidateBotCache } from '../cache/cache-service.js';

interface ScheduledJob {
  skillId: string;
  botId: string;
  userId: string;
  schedule: string;
  task: ScheduledTask;
}

interface NotificationJob {
  notificationId: string;
  botId: string;
  userId: string;
  sessionId: string;
  message: string;
  schedule: string;
  task: ScheduledTask;
}

export class CronScheduler {
  private jobs: Map<string, ScheduledJob> = new Map();
  private notificationJobs: Map<string, NotificationJob> = new Map();

  constructor(private readonly orchestrator: MessageOrchestrator) {}

  /**
   * Load all scheduled skills and notification jobs from the database.
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
      console.error('[scheduler] Failed to initialize skill jobs:', (err as Error).message);
    }

    try {
      const notifications = await notificationRepo.getActiveNotifications();
      console.log(`[scheduler] Found ${notifications.length} recurring notification(s)`);
      for (const n of notifications) {
        this.registerNotificationJob(n.notificationId, n.botId, n.userId, n.sessionId, n.message, n.schedule);
      }
    } catch (err) {
      console.error('[scheduler] Failed to initialize notification jobs:', (err as Error).message);
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
   * Register a recurring notification cron job.
   * When fired, writes an assistant message to the user's session in the DB.
   */
  registerNotificationJob(
    notificationId: string,
    botId: string,
    userId: string,
    notifSessionId: string,
    message: string,
    schedule: string,
  ): void {
    // Remove existing job for this notification if re-registering
    const existing = this.notificationJobs.get(notificationId);
    if (existing) {
      existing.task.stop();
      this.notificationJobs.delete(notificationId);
    }

    if (!cron.validate(schedule)) {
      console.warn(`[scheduler] Invalid cron for notification ${notificationId}: ${schedule}`);
      return;
    }

    const task = cron.schedule(schedule, () => {
      this.fireNotification(notificationId, botId, userId, notifSessionId, message).catch((err) => {
        console.error(`[scheduler] Notification fire failed (${notificationId}):`, (err as Error).message);
      });
    });

    this.notificationJobs.set(notificationId, {
      notificationId,
      botId,
      userId,
      sessionId: notifSessionId,
      message,
      schedule,
      task,
    });

    console.log(`[scheduler] Registered notification [${schedule}]: "${message.slice(0, 50)}"`);
  }

  private async fireNotification(
    notificationId: string,
    botId: string,
    userId: string,
    notifSessionId: string,
    message: string,
  ): Promise<void> {
    try {
      requestContext.enterWith({ userId });
      console.log(`\n🔔 NOTIFICATION [bot: ${botId}]: ${message}\n`);
      await messageRepo.insertMessage({
        sessionId: notifSessionId,
        botId,
        role: 'assistant',
        content: `🔔 **Reminder**: ${message}`,
      });
      await notificationRepo.markNotificationFired(notificationId);
    } catch (err) {
      console.error('[scheduler] Could not persist notification:', (err as Error).message);
    }
  }

  /**
   * Cancel a recurring notification job by ID.
   */
  cancelNotificationJob(notificationId: string): void {
    const existing = this.notificationJobs.get(notificationId);
    if (existing) {
      existing.task.stop();
      this.notificationJobs.delete(notificationId);
      console.log(`[scheduler] Cancelled notification job: ${notificationId}`);
    }
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
    for (const [, job] of this.notificationJobs) {
      job.task.stop();
    }
    const count = this.jobs.size + this.notificationJobs.size;
    this.jobs.clear();
    this.notificationJobs.clear();
    console.log(`[scheduler] Stopped ${count} job(s)`);
  }

  /**
   * Get current job count (for health checks / diagnostics).
   */
  get jobCount(): number {
    return this.jobs.size + this.notificationJobs.size;
  }
}
