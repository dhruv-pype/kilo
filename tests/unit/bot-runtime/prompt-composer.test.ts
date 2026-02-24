import { describe, it, expect } from 'vitest';
import { composeSkillPrompt, composeGeneralPrompt } from '@bot-runtime/prompt-composer/prompt-composer.js';
import type { CompositionInput, GeneralCompositionInput } from '@common/types/orchestrator.js';
import type { SkillDefinition } from '@common/types/skill.js';
import type { BotId, MessageId, SessionId, SkillId, UserId } from '@common/types/ids.js';

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    skillId: 'skill-1' as SkillId,
    botId: 'bot-1' as BotId,
    name: 'Order Tracker',
    description: 'Track customer orders for the bakery',
    triggerPatterns: ['new order', 'show orders'],
    behaviorPrompt: 'You help track bakery orders. Extract customer name, item, and pickup date.',
    inputSchema: null,
    outputFormat: 'text',
    schedule: null,
    dataTable: 'orders',
    readableTables: [],
    tableSchema: null,
    requiredIntegrations: [],
    createdBy: 'user_conversation',
    version: 1,
    performanceScore: 0.5,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeCompositionInput(overrides: Partial<CompositionInput> = {}): CompositionInput {
  return {
    skill: makeSkill(),
    message: {
      messageId: 'msg-1' as MessageId,
      sessionId: 'sess-1' as SessionId,
      botId: 'bot-1' as BotId,
      userId: 'user-1' as UserId,
      content: 'New order: Maria, chocolate cake, Saturday',
      attachments: [],
      timestamp: new Date(),
    },
    conversationHistory: [],
    memoryContext: [],
    ragResults: [],
    skillData: { tableName: 'orders', rows: [], totalCount: 0 },
    tableSchemas: [],
    ...overrides,
  };
}

describe('composeSkillPrompt', () => {
  it('includes skill name and instructions in system prompt', () => {
    const result = composeSkillPrompt(makeCompositionInput());
    expect(result.system).toContain('Order Tracker');
    expect(result.system).toContain('You help track bakery orders');
  });

  it('includes user message in messages array', () => {
    const result = composeSkillPrompt(makeCompositionInput());
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toContain('Maria, chocolate cake');
  });

  it('includes conversation history before current message', () => {
    const result = composeSkillPrompt(makeCompositionInput({
      conversationHistory: [
        {
          messageId: 'msg-0' as MessageId,
          sessionId: 'sess-1' as SessionId,
          botId: 'bot-1' as BotId,
          role: 'user',
          content: 'Hello',
          attachments: [],
          skillId: null,
          timestamp: new Date(),
        },
      ],
    }));
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toBe('Hello');
  });

  it('includes memory context when provided', () => {
    const result = composeSkillPrompt(makeCompositionInput({
      memoryContext: [
        { key: 'bakery_name', value: 'Sweet Crumb', source: 'user_stated', confidence: 0.9, createdAt: new Date() },
      ],
    }));
    expect(result.system).toContain('USER CONTEXT');
    expect(result.system).toContain('Sweet Crumb');
  });

  it('includes RAG results when provided', () => {
    const result = composeSkillPrompt(makeCompositionInput({
      ragResults: [
        { content: 'Chocolate cake: $35, serves 12', documentId: 'menu-pdf', relevanceScore: 0.9 },
      ],
    }));
    expect(result.system).toContain('RELEVANT KNOWLEDGE');
    expect(result.system).toContain('Chocolate cake: $35');
  });

  it('includes table schemas when provided', () => {
    const result = composeSkillPrompt(makeCompositionInput({
      tableSchemas: [{
        tableName: 'orders',
        columns: [
          { name: 'customer_name', type: 'TEXT', nullable: false },
          { name: 'pickup_date', type: 'DATE', nullable: false },
        ],
      }],
    }));
    expect(result.system).toContain('AVAILABLE DATA TABLES');
    expect(result.system).toContain('customer_name');
  });

  it('includes skill data snapshot when available', () => {
    const result = composeSkillPrompt(makeCompositionInput({
      skillData: {
        tableName: 'orders',
        rows: [{ customer_name: 'Tom', pickup_date: '2026-03-01' }],
        totalCount: 1,
      },
    }));
    expect(result.system).toContain('CURRENT DATA');
    expect(result.system).toContain('Tom');
  });

  it('generates query_skill_data tool when skill has data table', () => {
    const result = composeSkillPrompt(makeCompositionInput());
    expect(result.tools.some((t) => t.name === 'query_skill_data')).toBe(true);
  });

  it('generates insert_skill_data tool when skill has data table', () => {
    const result = composeSkillPrompt(makeCompositionInput());
    expect(result.tools.some((t) => t.name === 'insert_skill_data')).toBe(true);
  });

  it('does not generate data tools when skill has no data table', () => {
    const result = composeSkillPrompt(makeCompositionInput({
      skill: makeSkill({ dataTable: null, readableTables: [] }),
    }));
    expect(result.tools.some((t) => t.name === 'query_skill_data')).toBe(false);
    expect(result.tools.some((t) => t.name === 'insert_skill_data')).toBe(false);
  });

  it('always includes schedule_notification tool', () => {
    const result = composeSkillPrompt(makeCompositionInput({
      skill: makeSkill({ dataTable: null }),
    }));
    expect(result.tools.some((t) => t.name === 'schedule_notification')).toBe(true);
  });

  it('includes safety constraint about not fabricating data', () => {
    const result = composeSkillPrompt(makeCompositionInput());
    expect(result.system).toContain('Never fabricate data');
  });
});

describe('composeGeneralPrompt', () => {
  it('includes bot name and personality', () => {
    const input: GeneralCompositionInput = {
      message: {
        messageId: 'msg-1' as MessageId,
        sessionId: 'sess-1' as SessionId,
        botId: 'bot-1' as BotId,
        userId: 'user-1' as UserId,
        content: 'How are you?',
        attachments: [],
        timestamp: new Date(),
      },
      conversationHistory: [],
      memoryContext: [],
      botConfig: {
        name: 'Sweet Crumb Bot',
        personality: 'Friendly and helpful bakery assistant',
        context: 'This is a bakery with 5 employees',
        soul: null,
      },
    };
    const result = composeGeneralPrompt(input);
    expect(result.system).toContain('Sweet Crumb Bot');
    expect(result.system).toContain('Friendly and helpful');
  });

  it('suggests creating skills for unhandled requests', () => {
    const input: GeneralCompositionInput = {
      message: {
        messageId: 'msg-1' as MessageId,
        sessionId: 'sess-1' as SessionId,
        botId: 'bot-1' as BotId,
        userId: 'user-1' as UserId,
        content: 'Track my expenses',
        attachments: [],
        timestamp: new Date(),
      },
      conversationHistory: [],
      memoryContext: [],
      botConfig: { name: 'Bot', personality: '', context: '', soul: null },
    };
    const result = composeGeneralPrompt(input);
    expect(result.system).toContain('suggest creating a new skill');
  });

  it('generates no tools for general conversation', () => {
    const input: GeneralCompositionInput = {
      message: {
        messageId: 'msg-1' as MessageId,
        sessionId: 'sess-1' as SessionId,
        botId: 'bot-1' as BotId,
        userId: 'user-1' as UserId,
        content: 'Hello',
        attachments: [],
        timestamp: new Date(),
      },
      conversationHistory: [],
      memoryContext: [],
      botConfig: { name: 'Bot', personality: '', context: '', soul: null },
    };
    const result = composeGeneralPrompt(input);
    expect(result.tools).toHaveLength(0);
  });

  it('includes CAPABILITIES section in general prompt', () => {
    const input: GeneralCompositionInput = {
      message: {
        messageId: 'msg-1' as MessageId,
        sessionId: 'sess-1' as SessionId,
        botId: 'bot-1' as BotId,
        userId: 'user-1' as UserId,
        content: 'What can you do?',
        attachments: [],
        timestamp: new Date(),
      },
      conversationHistory: [],
      memoryContext: [],
      botConfig: { name: 'Bot', personality: '', context: '', soul: null },
    };
    const result = composeGeneralPrompt(input);
    expect(result.system).toContain('CAPABILITIES:');
    expect(result.system).toContain('learn new API integrations');
    expect(result.system).toContain('propose and create new skills');
    expect(result.system).toContain('remember facts from previous conversations');
  });

  it('includes skill summary when provided', () => {
    const input: GeneralCompositionInput = {
      message: {
        messageId: 'msg-1' as MessageId,
        sessionId: 'sess-1' as SessionId,
        botId: 'bot-1' as BotId,
        userId: 'user-1' as UserId,
        content: 'Hello',
        attachments: [],
        timestamp: new Date(),
      },
      conversationHistory: [],
      memoryContext: [],
      botConfig: { name: 'Bot', personality: '', context: '', soul: null },
      skillSummary: [
        { name: 'Order Tracker', description: 'Track bakery orders' },
        { name: 'Daily Report', description: 'Generate end-of-day summary' },
      ],
    };
    const result = composeGeneralPrompt(input);
    expect(result.system).toContain('YOUR CURRENT SKILLS:');
    expect(result.system).toContain('Order Tracker: Track bakery orders');
    expect(result.system).toContain('Daily Report: Generate end-of-day summary');
  });

  it('omits skill summary section when skillSummary is empty', () => {
    const input: GeneralCompositionInput = {
      message: {
        messageId: 'msg-1' as MessageId,
        sessionId: 'sess-1' as SessionId,
        botId: 'bot-1' as BotId,
        userId: 'user-1' as UserId,
        content: 'Hello',
        attachments: [],
        timestamp: new Date(),
      },
      conversationHistory: [],
      memoryContext: [],
      botConfig: { name: 'Bot', personality: '', context: '', soul: null },
      skillSummary: [],
    };
    const result = composeGeneralPrompt(input);
    expect(result.system).not.toContain('YOUR CURRENT SKILLS:');
  });

  it('omits skill summary section when skillSummary is undefined', () => {
    const input: GeneralCompositionInput = {
      message: {
        messageId: 'msg-1' as MessageId,
        sessionId: 'sess-1' as SessionId,
        botId: 'bot-1' as BotId,
        userId: 'user-1' as UserId,
        content: 'Hello',
        attachments: [],
        timestamp: new Date(),
      },
      conversationHistory: [],
      memoryContext: [],
      botConfig: { name: 'Bot', personality: '', context: '', soul: null },
    };
    const result = composeGeneralPrompt(input);
    expect(result.system).not.toContain('YOUR CURRENT SKILLS:');
  });

  it('constraint mentions learning API integrations', () => {
    const input: GeneralCompositionInput = {
      message: {
        messageId: 'msg-1' as MessageId,
        sessionId: 'sess-1' as SessionId,
        botId: 'bot-1' as BotId,
        userId: 'user-1' as UserId,
        content: 'Hello',
        attachments: [],
        timestamp: new Date(),
      },
      conversationHistory: [],
      memoryContext: [],
      botConfig: { name: 'Bot', personality: '', context: '', soul: null },
    };
    const result = composeGeneralPrompt(input);
    expect(result.system).toContain('learning a new API integration');
  });
});
