import { describe, it, expect, vi } from 'vitest';
import { evaluateForProposal } from '@bot-runtime/skill-proposer/skill-proposer.js';
import type { UserMessage } from '@common/types/message.js';
import type { BotId, MessageId, SessionId, UserId } from '@common/types/ids.js';
import type { LLMGatewayPort } from '@bot-runtime/orchestrator/message-orchestrator.js';
import type { SkillProposal } from '@common/types/orchestrator.js';

function makeMessage(content: string): UserMessage {
  return {
    messageId: 'msg-1' as MessageId,
    sessionId: 'sess-1' as SessionId,
    botId: 'bot-1' as BotId,
    userId: 'user-1' as UserId,
    content,
    attachments: [],
    timestamp: new Date(),
  };
}

const noContext = { recentDismissals: [] };

// ─── LLM mock helpers ─────────────────────────────────────────

function makeLLM(proposal: Partial<SkillProposal> | null): LLMGatewayPort {
  return {
    complete: vi.fn().mockResolvedValue({
      content: '',
      toolCalls: proposal
        ? [{
            toolName: 'propose_skill',
            arguments: {
              proposedName: proposal.proposedName ?? 'Test Skill',
              description: proposal.description ?? 'A test skill',
              triggerExamples: proposal.triggerExamples ?? ['test'],
              suggestedInputFields: proposal.suggestedInputFields ?? [],
              suggestedSchedule: proposal.suggestedSchedule ?? null,
              clarifyingQuestions: proposal.clarifyingQuestions ?? ['What should I track?'],
              confidence: proposal.confidence ?? 0.8,
              dataModel: proposal.dataModel ?? 'per_entry',
            },
          }]
        : [{ toolName: 'no_proposal', arguments: { reason: 'one-off question' } }],
    }),
  };
}

describe('evaluateForProposal', () => {
  // ─── Should Propose ─────────────────────────────────────────

  it('proposes a tracker when LLM returns propose_skill', async () => {
    const llm = makeLLM({ proposedName: 'Orders Tracker', confidence: 0.8 });
    const result = await evaluateForProposal(makeMessage('I want to keep track of my orders'), [], noContext, llm);
    expect(result).not.toBeNull();
    expect(result!.proposedName).toContain('Orders');
  });

  it('proposes a reminder when LLM returns propose_skill', async () => {
    const llm = makeLLM({ proposedName: 'Call Supplier Reminder', suggestedSchedule: '0 15 * * *' });
    const result = await evaluateForProposal(makeMessage('Remind me to call the flour supplier at 3pm'), [], noContext, llm);
    expect(result).not.toBeNull();
    expect(result!.proposedName).toContain('Reminder');
  });

  it('returns a schedule from the LLM proposal', async () => {
    const llm = makeLLM({ proposedName: 'Morning Summary', suggestedSchedule: '30 6 * * *' });
    const result = await evaluateForProposal(
      makeMessage('Every morning send me a summary of today'),
      [],
      noContext,
      llm,
    );
    expect(result).not.toBeNull();
    expect(result!.suggestedSchedule).toBe('30 6 * * *');
  });

  it('returns 8AM schedule from LLM for "Give me all the AI news at 8AM everyday"', async () => {
    const llm = makeLLM({ proposedName: 'Daily AI News', suggestedSchedule: '0 8 * * *', confidence: 0.9 });
    const result = await evaluateForProposal(
      makeMessage('Give me all the AI news for the day at 8AM everyday'),
      [],
      noContext,
      llm,
    );
    expect(result).not.toBeNull();
    expect(result!.suggestedSchedule).not.toBeNull();
    expect(result!.suggestedSchedule).toContain('8');
  });

  // ─── Should NOT Propose ──────────────────────────────────────

  it('returns null when LLM returns no_proposal', async () => {
    const llm = makeLLM(null);
    const result = await evaluateForProposal(makeMessage('What time is it?'), [], noContext, llm);
    expect(result).toBeNull();
  });

  it('returns null when toolCalls is empty', async () => {
    const llm: LLMGatewayPort = {
      complete: vi.fn().mockResolvedValue({ content: '', toolCalls: [] }),
    };
    const result = await evaluateForProposal(makeMessage('Hello'), [], noContext, llm);
    expect(result).toBeNull();
  });

  // ─── Dismissal Cooldown ──────────────────────────────────────

  it('does NOT re-propose a recently dismissed skill', async () => {
    const llm = makeLLM({ proposedName: 'Orders Tracker' });
    const result = await evaluateForProposal(
      makeMessage('Keep track of my orders'),
      [],
      {
        recentDismissals: [
          { proposedName: 'Orders Tracker', dismissedAt: new Date() },
        ],
      },
      llm,
    );
    expect(result).toBeNull();
  });

  it('DOES re-propose after the 7-day cooldown', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const llm = makeLLM({ proposedName: 'Orders Tracker' });
    const result = await evaluateForProposal(
      makeMessage('Keep track of my orders'),
      [],
      {
        recentDismissals: [
          { proposedName: 'Orders Tracker', dismissedAt: eightDaysAgo },
        ],
      },
      llm,
    );
    expect(result).not.toBeNull();
  });

  // ─── Proposal Quality ────────────────────────────────────────

  it('includes clarifying questions from LLM', async () => {
    const llm = makeLLM({ clarifyingQuestions: ['What details should I capture per expense?'] });
    const result = await evaluateForProposal(makeMessage('Track my expenses'), [], noContext, llm);
    expect(result).not.toBeNull();
    expect(result!.clarifyingQuestions.length).toBeGreaterThan(0);
  });

  it('includes trigger examples from LLM', async () => {
    const llm = makeLLM({ triggerExamples: ['new order', 'add order', 'show my orders'] });
    const result = await evaluateForProposal(makeMessage('Track my orders'), [], noContext, llm);
    expect(result).not.toBeNull();
    expect(result!.triggerExamples.length).toBeGreaterThan(0);
  });

  it('clamps confidence to [0, 1]', async () => {
    const llm = makeLLM({ confidence: 1.5 }); // over max
    const result = await evaluateForProposal(makeMessage('Track my workouts'), [], noContext, llm);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeLessThanOrEqual(1);
    expect(result!.confidence).toBeGreaterThan(0);
  });
});
