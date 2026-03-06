import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import type { MessageOrchestrator } from '../../bot-runtime/orchestrator/message-orchestrator.js';
import type { TrackedLLMGateway } from '../../llm-gateway/tracked-llm-gateway.js';
import type { CronScheduler } from '../../scheduler/cron-scheduler.js';
import * as messageRepo from '../../database/repositories/message-repository.js';
import * as notificationRepo from '../../database/repositories/notification-repository.js';
import { messageId, sessionId } from '../../common/types/ids.js';
import type { BotId } from '../../common/types/ids.js';
import type { Attachment } from '../../common/types/message.js';
import * as memoryRepo from '../../database/repositories/memory-repository.js';
import * as botRepo from '../../database/repositories/bot-repository.js';
import * as skillDataRepo from '../../database/repositories/skill-data-repository.js';
import * as proposalRepo from '../../database/repositories/skill-proposal-repository.js';
import * as refinementRepo from '../../database/repositories/skill-refinement-repository.js';
import { applySoulPatches } from '../../bot-runtime/soul-evolver/soul-evolver.js';
import { invalidateBotCache } from '../../cache/cache-service.js';

/**
 * Chat routes — the core message endpoint.
 *
 * POST /api/chat — Send a message to a bot and get a response.
 * The Orchestrator handles everything: skill matching, context loading,
 * LLM call, response processing, and side effects.
 *
 * The TrackedLLMGateway is passed so we can set the attribution context
 * (userId, botId, sessionId) before each orchestrator call.
 *
 * WebSocket support (for typing indicators + streaming) is a future
 * enhancement. REST is sufficient for v1 to get the product working.
 */
export function chatRoutes(
  app: FastifyInstance,
  orchestrator: MessageOrchestrator,
  trackedGateway?: TrackedLLMGateway,
  scheduler?: CronScheduler,
): void {

  app.post<{
    Body: {
      botId: string;
      sessionId?: string;
      content: string;
      attachments?: { type: string; url: string; mimeType: string; fileName: string; sizeBytes: number }[];
    };
  }>('/api/chat', async (request) => {
    const body = request.body;
    const sid = body.sessionId ?? uuidv4();
    const authenticatedUserId = request.userId;

    // Build the UserMessage
    const userMessage = {
      messageId: messageId(uuidv4()),
      sessionId: sessionId(sid),
      botId: body.botId as BotId,
      userId: authenticatedUserId,
      content: body.content,
      attachments: (body.attachments ?? []) as Attachment[],
      timestamp: new Date(),
    };

    // Persist the user's message
    await messageRepo.insertMessage({
      sessionId: sid,
      botId: body.botId,
      role: 'user',
      content: body.content,
      attachments: body.attachments,
    });

    // Set usage tracking context so LLM costs are attributed to this user/bot/session
    if (trackedGateway) {
      trackedGateway.setContext({
        userId: authenticatedUserId as string,
        botId: body.botId,
        sessionId: sid,
        messageId: userMessage.messageId as string,
      });
    }

    // Run the Orchestrator pipeline
    const result = await orchestrator.process({
      message: userMessage,
      botId: body.botId as BotId,
      sessionId: sessionId(sid),
    });

    // Persist the assistant's response
    await messageRepo.insertMessage({
      sessionId: sid,
      botId: body.botId,
      role: 'assistant',
      content: result.response.content,
      skillId: result.response.skillId as string | null,
    });

    // Process side effects asynchronously (don't block the response)
    processSideEffects(result.sideEffects, body.botId, authenticatedUserId as string, scheduler).catch((err) => {
      console.error('Side effect processing failed:', err);
    });

    return {
      sessionId: sid,
      response: result.response,
    };
  });
}

/**
 * Process side effects asynchronously.
 * Memory writes, notifications, analytics — none of these should
 * delay the user's response.
 */
async function processSideEffects(
  sideEffects: import('../../common/types/orchestrator.js').SideEffect[],
  botId: string,
  userId: string,
  scheduler?: CronScheduler,
): Promise<void> {
  for (const effect of sideEffects) {
    switch (effect.type) {
      case 'memory_write':
        try {
          await memoryRepo.upsertFacts(botId, effect.facts);
          console.log(`[side-effect] Memory write: ${effect.facts.length} facts persisted`);
        } catch (err) {
          console.error(`[side-effect] Memory write failed:`, (err as Error).message);
        }
        break;
      case 'soul_update':
        try {
          const bot = await botRepo.getBotById(effect.botId);
          if (bot.soul) {
            const updatedSoul = applySoulPatches(bot.soul, effect.patches);
            await botRepo.updateBot(effect.botId, { soul: updatedSoul });
            await invalidateBotCache(effect.botId);
            console.log(`[side-effect] Soul updated: ${effect.patches.length} patches applied`);
          }
        } catch (err) {
          console.error(`[side-effect] Soul update failed:`, (err as Error).message);
        }
        break;
      case 'skill_data_write':
        try {
          const bot = await botRepo.getBotById(botId);
          if (effect.operation === 'insert') {
            await skillDataRepo.insertRow(bot.schemaName, effect.table, effect.data);
          } else if (effect.operation === 'update') {
            const { id, ...fields } = effect.data as { id: string } & Record<string, unknown>;
            await skillDataRepo.updateRow(bot.schemaName, effect.table, id, fields);
          }
          console.log(`[side-effect] Data ${effect.operation} on ${effect.table}`);
        } catch (err) {
          console.error(`[side-effect] skill_data_write failed:`, (err as Error).message);
        }
        break;
      case 'schedule_notification':
        scheduleNotification(botId, userId, effect.message, effect.at, effect.recurring, effect.sessionId, scheduler).catch((err) => {
          console.error('[side-effect] schedule_notification failed:', (err as Error).message);
        });
        break;
      case 'skill_proposal':
        try {
          await proposalRepo.insertProposal(botId, effect.proposalId, effect.proposal);
          console.log(`[side-effect] Proposal persisted: ${effect.proposal.proposedName}`);
        } catch (err) {
          console.error('[side-effect] proposal insert failed:', (err as Error).message);
        }
        break;
      case 'skill_refinement':
        try {
          await refinementRepo.saveRefinement(effect.skillId, effect.botId, effect.result);
          console.log(`[side-effect] Refinement persisted for skill: ${effect.skillId}`);
        } catch (err) {
          console.error('[side-effect] refinement insert failed:', (err as Error).message);
        }
        break;
      case 'analytics_event':
        console.log(`[side-effect] Analytics: ${effect.event}`);
        break;
    }
  }
}

/**
 * Schedule a one-time (or recurring) notification.
 *
 * One-time within 24.8 days: uses setTimeout. When fired, inserts an assistant
 * message into the user's session so they see it the next time they open chat.
 *
 * One-time further out: logged (BullMQ/Temporal needed for long-range scheduling).
 *
 * Recurring: persisted to DB and registered as a cron job in the scheduler
 * so it survives server restarts.
 */
async function scheduleNotification(
  botId: string,
  userId: string,
  message: string,
  at: Date,
  recurring: string | null,
  notifSessionId: string,
  scheduler?: CronScheduler,
): Promise<void> {
  if (recurring) {
    try {
      const notificationId = await notificationRepo.insertNotification(
        botId,
        userId,
        notifSessionId,
        message,
        recurring,
      );
      if (scheduler) {
        scheduler.registerNotificationJob(notificationId, botId, userId, notifSessionId, message, recurring);
        console.log(`[scheduler] Recurring notification registered (cron: ${recurring}): "${message}"`);
      } else {
        console.warn('[scheduler] Recurring notification persisted but no scheduler available to register job');
      }
    } catch (err) {
      console.error('[scheduler] Failed to persist recurring notification:', (err as Error).message);
    }
    return;
  }

  const delayMs = at.getTime() - Date.now();
  const MAX_SETTIMEOUT_MS = 2_147_483_647; // ~24.8 days — JS limit

  if (delayMs <= 0) {
    await fireNotification(botId, userId, notifSessionId, message);
    return;
  }

  if (delayMs > MAX_SETTIMEOUT_MS) {
    console.log(`[scheduler] Notification too far in future (${Math.round(delayMs / 86400000)}d): "${message}"`);
    return;
  }

  console.log(`[scheduler] Notification scheduled in ${Math.round(delayMs / 1000)}s: "${message}"`);
  setTimeout(() => {
    fireNotification(botId, userId, notifSessionId, message).catch((err) => {
      console.error('[scheduler] Failed to fire notification:', (err as Error).message);
    });
  }, delayMs);
}

/**
 * Fire a notification — writes it as an assistant message in the user's session
 * so it appears in the conversation history when they next open chat.
 */
async function fireNotification(botId: string, userId: string, notifSessionId: string, message: string): Promise<void> {
  console.log(`\n🔔 NOTIFICATION [bot: ${botId}]: ${message}\n`);
  try {
    const { requestContext } = await import('../../database/request-context.js');
    requestContext.enterWith({ userId });
    await messageRepo.insertMessage({
      sessionId: notifSessionId,
      botId,
      role: 'assistant',
      content: `🔔 **Reminder**: ${message}`,
    });
  } catch (err) {
    console.error('[scheduler] Could not persist notification:', (err as Error).message);
  }
}
