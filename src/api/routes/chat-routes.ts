import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import type { MessageOrchestrator } from '../../bot-runtime/orchestrator/message-orchestrator.js';
import type { TrackedLLMGateway } from '../../llm-gateway/tracked-llm-gateway.js';
import * as messageRepo from '../../database/repositories/message-repository.js';
import { messageId, sessionId } from '../../common/types/ids.js';
import type { BotId, UserId } from '../../common/types/ids.js';
import type { Attachment } from '../../common/types/message.js';

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
): void {

  app.post<{
    Body: {
      botId: string;
      userId: string;
      sessionId?: string;
      content: string;
      attachments?: { type: string; url: string; mimeType: string; fileName: string; sizeBytes: number }[];
    };
  }>('/api/chat', async (request) => {
    const body = request.body;
    const sid = body.sessionId ?? uuidv4();

    // Build the UserMessage
    const userMessage = {
      messageId: messageId(uuidv4()),
      sessionId: sessionId(sid),
      botId: body.botId as BotId,
      userId: body.userId as UserId,
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
        userId: body.userId,
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
    processSideEffects(result.sideEffects, body.botId).catch((err) => {
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
): Promise<void> {
  for (const effect of sideEffects) {
    switch (effect.type) {
      case 'memory_write':
        // TODO: Write to memory_facts table
        console.log(`[side-effect] Memory write: ${effect.facts.length} facts`);
        break;
      case 'skill_data_write':
        // TODO: Execute via data-executor
        console.log(`[side-effect] Data write to ${effect.table}: ${effect.operation}`);
        break;
      case 'schedule_notification':
        // TODO: Schedule via BullMQ/Temporal
        console.log(`[side-effect] Schedule notification: "${effect.message}" at ${effect.at}`);
        break;
      case 'skill_proposal':
        // Proposal is already included in the response content
        console.log(`[side-effect] Skill proposed: ${effect.proposal.proposedName}`);
        break;
      case 'analytics_event':
        console.log(`[side-effect] Analytics: ${effect.event}`);
        break;
    }
  }
}
