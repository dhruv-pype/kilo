import { describe, it, expect } from 'vitest';
import { evaluateForProposal } from '@bot-runtime/skill-proposer/skill-proposer.js';
import type { UserMessage } from '@common/types/message.js';
import type { BotId, MessageId, SessionId, UserId } from '@common/types/ids.js';

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

describe('evaluateForProposal', () => {
  // ─── Should Propose ──────────────────────────────────────────

  it('proposes a tracker for "keep track of my orders"', () => {
    const result = evaluateForProposal(makeMessage('I want to keep track of my orders'), [], noContext);
    expect(result).not.toBeNull();
    expect(result!.proposedName).toContain('Orders');
  });

  it('proposes a reminder for "remind me to call supplier"', () => {
    const result = evaluateForProposal(makeMessage('Remind me to call the flour supplier at 3pm'), [], noContext);
    expect(result).not.toBeNull();
    expect(result!.proposedName).toContain('Reminder');
  });

  it('proposes for "every morning send me a summary"', () => {
    const result = evaluateForProposal(
      makeMessage('Every morning send me a summary of today'),
      [],
      noContext,
    );
    expect(result).not.toBeNull();
    expect(result!.suggestedSchedule).not.toBeNull();
  });

  it('proposes a log for "log my daily expenses"', () => {
    const result = evaluateForProposal(makeMessage('I want to log my daily expenses'), [], noContext);
    expect(result).not.toBeNull();
    expect(result!.proposedName).toContain('Expenses');
  });

  it('proposes for "record my workouts"', () => {
    const result = evaluateForProposal(makeMessage('Record my workouts every day'), [], noContext);
    expect(result).not.toBeNull();
  });

  // ─── Should NOT Propose ──────────────────────────────────────

  it('does NOT propose for a one-off question', () => {
    const result = evaluateForProposal(makeMessage('What time is it?'), [], noContext);
    expect(result).toBeNull();
  });

  it('does NOT propose for general chat', () => {
    const result = evaluateForProposal(makeMessage('Hello, how are you today?'), [], noContext);
    expect(result).toBeNull();
  });

  it('does NOT propose for factual questions', () => {
    const result = evaluateForProposal(makeMessage('What is the capital of France?'), [], noContext);
    expect(result).toBeNull();
  });

  // ─── Dismissal Cooldown ──────────────────────────────────────

  it('does NOT re-propose a recently dismissed skill', () => {
    const result = evaluateForProposal(
      makeMessage('Keep track of my orders'),
      [],
      {
        recentDismissals: [
          { proposedName: 'Orders Tracker', dismissedAt: new Date() }, // just now
        ],
      },
    );
    expect(result).toBeNull();
  });

  it('DOES re-propose after the 7-day cooldown', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const result = evaluateForProposal(
      makeMessage('Keep track of my orders'),
      [],
      {
        recentDismissals: [
          { proposedName: 'Orders Tracker', dismissedAt: eightDaysAgo },
        ],
      },
    );
    expect(result).not.toBeNull();
  });

  // ─── Proposal Quality ───────────────────────────────────────

  it('includes clarifying questions', () => {
    const result = evaluateForProposal(makeMessage('Track my expenses'), [], noContext);
    expect(result).not.toBeNull();
    expect(result!.clarifyingQuestions.length).toBeGreaterThan(0);
  });

  it('includes trigger examples', () => {
    const result = evaluateForProposal(makeMessage('Track my orders'), [], noContext);
    expect(result).not.toBeNull();
    expect(result!.triggerExamples.length).toBeGreaterThan(0);
  });

  it('has confidence between 0 and 1', () => {
    const result = evaluateForProposal(makeMessage('Remind me every day to take vitamins'), [], noContext);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThan(0);
    expect(result!.confidence).toBeLessThanOrEqual(1);
  });

  it('generates a schedule for time-based requests', () => {
    const result = evaluateForProposal(
      makeMessage('Remind me at 3pm to check the oven'),
      [],
      noContext,
    );
    expect(result).not.toBeNull();
    expect(result!.suggestedSchedule).not.toBeNull();
    expect(result!.suggestedSchedule).toContain('15'); // 3pm = hour 15
  });
});
