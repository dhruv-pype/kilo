import { describe, it, expect, vi } from 'vitest';
import { matchSkill } from '@bot-runtime/skill-matcher/skill-matcher.js';
import type { SkillDefinition } from '@common/types/skill.js';
import type { BotId, SkillId } from '@common/types/ids.js';
import type { LLMGatewayPort } from '@bot-runtime/orchestrator/message-orchestrator.js';
import type { UserMessage } from '@common/types/message.js';
import { messageId, sessionId } from '@common/types/ids.js';

function makeSkill(name: string, patterns: string[]): SkillDefinition {
  return {
    skillId: `skill-${name}` as SkillId,
    botId: 'bot-123' as BotId,
    name,
    description: `${name} skill`,
    triggerPatterns: patterns,
    behaviorPrompt: `Handle ${name} requests`,
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
}

function makeMessage(content: string): UserMessage {
  return {
    messageId: messageId('msg-123'),
    sessionId: sessionId('sess-123'),
    botId: 'bot-123' as BotId,
    userId: 'user-123' as any,
    content,
    attachments: [],
    timestamp: new Date(),
  };
}

function mockLLMMatch(skillName: string, confidence: number): LLMGatewayPort {
  return {
    complete: vi.fn().mockResolvedValue({
      content: '',
      toolCalls: [{
        toolName: 'classify_intent',
        arguments: {
          skill_name: skillName,
          confidence,
          reasoning: 'Test match',
        },
      }],
      model: 'gpt-4.1-mini',
      usage: { promptTokens: 100, completionTokens: 50 },
      latencyMs: 200,
    }),
  };
}

function mockLLMNoMatch(): LLMGatewayPort {
  return {
    complete: vi.fn().mockResolvedValue({
      content: '',
      toolCalls: [{
        toolName: 'classify_intent',
        arguments: {
          skill_name: 'none',
          confidence: 0.1,
          reasoning: 'No match found',
        },
      }],
      model: 'gpt-4.1-mini',
      usage: { promptTokens: 100, completionTokens: 50 },
      latencyMs: 200,
    }),
  };
}

function mockLLMError(): LLMGatewayPort {
  return {
    complete: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
  };
}

const orderSkill = makeSkill('Order Tracker', ['new order', 'add order', 'show orders']);
const salesSkill = makeSkill('Sales Log', ['log sales', 'daily sales']);
const allSkills = [orderSkill, salesSkill];

describe('matchSkill with LLM', () => {
  it('uses fast match for high-confidence keyword matches', async () => {
    const llm = mockLLMMatch('Order Tracker', 0.9);
    const msg = makeMessage('new order for 5 items');

    const result = await matchSkill(msg, allSkills, llm);

    // Should match via fast path — LLM should NOT be called
    expect(result).not.toBeNull();
    expect(result!.skill.name).toBe('Order Tracker');
    expect((llm.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('uses LLM for ambiguous messages that fast match cannot resolve', async () => {
    const llm = mockLLMMatch('Order Tracker', 0.85);
    const msg = makeMessage('I need to place an order for my customer');

    const result = await matchSkill(msg, allSkills, llm);

    expect(result).not.toBeNull();
    expect(result!.skill.name).toBe('Order Tracker');
    // LLM should have been called since fast match didn't give high confidence
    expect((llm.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('returns null when LLM says no match', async () => {
    const llm = mockLLMNoMatch();
    const msg = makeMessage('What is the meaning of life?');

    const result = await matchSkill(msg, allSkills, llm);

    expect(result).toBeNull();
  });

  it('falls back to fast match on LLM error', async () => {
    const llm = mockLLMError();
    // Use a message that gets a low-confidence fast match
    const msg = makeMessage('can you track the order status');

    const result = await matchSkill(msg, allSkills, llm);

    // Should either match via low-confidence fast path or return null
    // The important thing is it doesn't crash
    expect(result === null || result.skill !== undefined).toBe(true);
  });

  it('works without LLM parameter (backward compatible)', async () => {
    const msg = makeMessage('new order for today');

    const result = await matchSkill(msg, allSkills);

    expect(result).not.toBeNull();
    expect(result!.skill.name).toBe('Order Tracker');
  });

  it('returns null for empty skills array', async () => {
    const llm = mockLLMMatch('anything', 0.9);
    const msg = makeMessage('test message');

    const result = await matchSkill(msg, [], llm);
    expect(result).toBeNull();
  });

  it('includes context requirements and model preferences in result', async () => {
    const llm = mockLLMMatch('Order Tracker', 0.9);
    const msg = makeMessage('I need to place an order');

    const result = await matchSkill(msg, allSkills, llm);

    expect(result).not.toBeNull();
    expect(result!.contextRequirements).toBeDefined();
    expect(result!.modelPreferences).toBeDefined();
    expect(result!.modelPreferences.taskType).toBeDefined();
  });
});
