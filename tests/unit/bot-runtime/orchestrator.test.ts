import { describe, it, expect, vi } from 'vitest';
import { MessageOrchestrator } from '@bot-runtime/orchestrator/message-orchestrator.js';
import type { LLMGatewayPort, DataLoaderPort } from '@bot-runtime/orchestrator/message-orchestrator.js';
import type { BotId, MessageId, SessionId, SkillId, UserId } from '@common/types/ids.js';
import type { SkillDefinition } from '@common/types/skill.js';
import { getBuiltInSkills } from '../../../src/skill-engine/builtin-skills/index.js';

// ─── Mock Factory ──────────────────────────────────────────────

function makeSkill(name: string, patterns: string[]): SkillDefinition {
  return {
    skillId: `skill-${name}` as SkillId,
    botId: 'bot-1' as BotId,
    name,
    description: `${name} skill`,
    triggerPatterns: patterns,
    behaviorPrompt: `Handle ${name} requests. Be helpful and concise.`,
    inputSchema: null,
    outputFormat: 'text',
    schedule: null,
    needsHistory: true,
    needsMemory: true,
    dataTable: name === 'Order Tracker' ? 'orders' : null,
    readsData: false,
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

const BASE_RESPONSE = {
  content: 'Here is your response.',
  toolCalls: [],
  model: 'claude-sonnet-4-5-20250929',
  usage: { promptTokens: 100, completionTokens: 50 },
  latencyMs: 500,
};

const NO_PROPOSAL_RESPONSE = {
  content: '',
  toolCalls: [{ toolName: 'no_proposal', arguments: { reason: 'not a repeatable need' } }],
  model: 'claude-haiku-4-5-20251001',
  usage: { promptTokens: 50, completionTokens: 10 },
  latencyMs: 100,
};

const PROPOSAL_RESPONSE = {
  content: '',
  toolCalls: [{
    toolName: 'propose_skill',
    arguments: {
      proposedName: 'Expenses Tracker',
      description: 'Track and manage your expenses',
      triggerExamples: ['add expense', 'log expense', 'show expenses'],
      suggestedInputFields: [{ name: 'amount', type: 'number', description: 'Expense amount', required: true }],
      suggestedSchedule: null,
      clarifyingQuestions: ['What categories should I track?'],
      confidence: 0.85,
      dataModel: 'per_entry',
    },
  }],
  model: 'claude-haiku-4-5-20251001',
  usage: { promptTokens: 50, completionTokens: 20 },
  latencyMs: 200,
};

/** Default mock — never proposes a skill (intent_classification → no_proposal). */
function mockLLM(): LLMGatewayPort {
  return {
    complete: vi.fn().mockImplementation((_prompt, options) => {
      if (options?.taskType === 'intent_classification') {
        return Promise.resolve(NO_PROPOSAL_RESPONSE);
      }
      return Promise.resolve(BASE_RESPONSE);
    }),
  };
}

/** Mock that returns a skill proposal when the proposer calls intent_classification. */
function mockProposingLLM(): LLMGatewayPort {
  return {
    complete: vi.fn().mockImplementation((_prompt, options) => {
      if (options?.taskType === 'intent_classification') {
        return Promise.resolve(PROPOSAL_RESPONSE);
      }
      return Promise.resolve(BASE_RESPONSE);
    }),
  };
}

function mockDataLoader(skills: SkillDefinition[] = []): DataLoaderPort {
  return {
    loadBotConfig: vi.fn().mockResolvedValue({
      botId: 'bot-1',
      userId: 'user-1',
      name: 'Sweet Crumb Bot',
      description: 'Bakery assistant',
      personality: 'Friendly and helpful',
      context: 'A bakery with 5 employees',
      soul: null,
      schemaName: 'bot_a1b2c3d4',
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    loadSkills: vi.fn().mockResolvedValue(skills),
    loadConversationHistory: vi.fn().mockResolvedValue([]),
    loadMemoryFacts: vi.fn().mockResolvedValue([]),
    loadRAGResults: vi.fn().mockResolvedValue([]),
    loadSkillData: vi.fn().mockResolvedValue({ tableName: '', rows: [], totalCount: 0 }),
    loadTableSchemas: vi.fn().mockResolvedValue([]),
    loadRecentDismissals: vi.fn().mockResolvedValue([]),
    loadTools: vi.fn().mockResolvedValue([]),
    querySkillData: vi.fn().mockResolvedValue([]),
    loadProposal: vi.fn().mockResolvedValue(null),
    createSkill: vi.fn().mockResolvedValue(undefined),
    acceptProposal: vi.fn().mockResolvedValue(undefined),
    dismissProposal: vi.fn().mockResolvedValue(undefined),
    updateSkill: vi.fn().mockResolvedValue(undefined),
    saveRefinement: vi.fn().mockResolvedValue('refine-001'),
    loadRefinement: vi.fn().mockResolvedValue(null),
    applyRefinement: vi.fn().mockResolvedValue(undefined),
    dismissRefinement: vi.fn().mockResolvedValue(undefined),
  };
}

function makeInput(content: string) {
  return {
    message: {
      messageId: 'msg-1' as MessageId,
      sessionId: 'sess-1' as SessionId,
      botId: 'bot-1' as BotId,
      userId: 'user-1' as UserId,
      content,
      attachments: [],
      timestamp: new Date(),
    },
    botId: 'bot-1' as BotId,
    sessionId: 'sess-1' as SessionId,
  };
}

/**
 * Helper: count LLM calls by task type.
 * Memory extraction, soul extraction, and intent classification calls
 * are background "cheap LLM" calls and should not count toward
 * the main skill/conversation flow assertions.
 */
function getMainLLMCalls(llm: LLMGatewayPort): number {
  const calls = (llm.complete as ReturnType<typeof vi.fn>).mock.calls;
  return calls.filter((c) => {
    const taskType = c[1]?.taskType;
    return taskType !== 'memory_extraction' && taskType !== 'soul_extraction' && taskType !== 'intent_classification';
  }).length;
}

// ─── Tests ─────────────────────────────────────────────────────

describe('MessageOrchestrator', () => {
  it('routes to matched skill and calls LLM', async () => {
    const skills = [makeSkill('Order Tracker', ['new order', 'add order'])];
    const llm = mockLLM();
    const data = mockDataLoader(skills);
    const orchestrator = new MessageOrchestrator(llm, data);

    const result = await orchestrator.process(makeInput('New order for Maria'));

    // Content now has a skill-exec marker prepended for post-execution feedback detection
    expect(result.response.content).toContain('Here is your response.');
    expect(getMainLLMCalls(llm)).toBe(1);
    expect(result.response.skillId).toBe('skill-Order Tracker');
  });

  it('falls through to general conversation when no skill matches', async () => {
    const llm = mockLLM();
    const data = mockDataLoader([]);  // no skills
    const orchestrator = new MessageOrchestrator(llm, data);

    const result = await orchestrator.process(makeInput('Hello, how are you?'));

    expect(result.response.content).toBe('Here is your response.');
    expect(getMainLLMCalls(llm)).toBe(1);
    expect(result.response.skillId).toBeNull();
  });

  it('proposes a skill when message implies repeatable need', async () => {
    const llm = mockProposingLLM();
    const data = mockDataLoader([]);
    const orchestrator = new MessageOrchestrator(llm, data);

    const result = await orchestrator.process(makeInput('I want to keep track of my expenses'));

    // Should include a skill proposal in the response or side effects
    const proposalEffect = result.sideEffects.find((e) => e.type === 'skill_proposal');
    expect(proposalEffect).toBeDefined();
    expect(result.response.content).toContain("can learn");
  });

  it('extracts memory facts from user messages', async () => {
    const llm = mockLLM();
    const data = mockDataLoader([]);
    const orchestrator = new MessageOrchestrator(llm, data);

    const result = await orchestrator.process(
      makeInput('My bakery is called Sweet Crumb Bakery'),
    );

    const memoryEffect = result.sideEffects.find((e) => e.type === 'memory_write');
    expect(memoryEffect).toBeDefined();
    if (memoryEffect?.type === 'memory_write') {
      // With LLM extraction, we might get different keys. Just check that facts exist.
      expect(memoryEffect.facts.length).toBeGreaterThan(0);
    }
  });

  it('loads bot config and skills on every message', async () => {
    const llm = mockLLM();
    const data = mockDataLoader([]);
    const orchestrator = new MessageOrchestrator(llm, data);

    await orchestrator.process(makeInput('Hello'));

    expect(data.loadBotConfig).toHaveBeenCalledWith('bot-1');
    expect(data.loadSkills).toHaveBeenCalledWith('bot-1');
  });

  it('loads bot config and skills in parallel', async () => {
    const llm = mockLLM();
    const data = mockDataLoader([]);

    // Track call order
    const callOrder: string[] = [];
    (data.loadBotConfig as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('config_start');
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push('config_end');
      return {
        botId: 'bot-1', userId: 'user-1', name: 'Bot', description: '',
        personality: '', context: '', soul: null, schemaName: 'bot_a1b2c3d4',
        createdAt: new Date(), updatedAt: new Date(),
      };
    });
    (data.loadSkills as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('skills_start');
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push('skills_end');
      return [];
    });

    const orchestrator = new MessageOrchestrator(llm, data);
    await orchestrator.process(makeInput('Hello'));

    // Both should start before either ends (parallel execution)
    expect(callOrder.indexOf('config_start')).toBeLessThan(callOrder.indexOf('skills_end'));
    expect(callOrder.indexOf('skills_start')).toBeLessThan(callOrder.indexOf('config_end'));
  });

  it('handles LLM tool calls as side effects', async () => {
    const skills = [makeSkill('Order Tracker', ['new order'])];
    const llm: LLMGatewayPort = {
      complete: vi.fn().mockResolvedValue({
        content: 'Order logged!',
        toolCalls: [
          {
            toolName: 'insert_skill_data',
            arguments: { data: { customer_name: 'Maria', pickup_date: '2026-03-01' } },
          },
          {
            toolName: 'schedule_notification',
            arguments: { message: 'Reminder: Maria pickup tomorrow', at: '2026-02-28T19:00:00Z' },
          },
        ],
        model: 'claude-sonnet-4-5-20250929',
        usage: { promptTokens: 100, completionTokens: 50 },
        latencyMs: 500,
      }),
    };
    const data = mockDataLoader(skills);
    const orchestrator = new MessageOrchestrator(llm, data);

    const result = await orchestrator.process(makeInput('New order: Maria, chocolate cake, Saturday'));

    const dataWrite = result.sideEffects.find((e) => e.type === 'skill_data_write');
    expect(dataWrite).toBeDefined();

    const notification = result.sideEffects.find((e) => e.type === 'schedule_notification');
    expect(notification).toBeDefined();
  });

  // ─── Built-in Skill Tests ─────────────────────────────────────

  it('routes built-in skill without calling main LLM', async () => {
    const llm = mockLLM();
    const data = mockDataLoader([]); // no DB skills — built-ins are merged automatically
    const orchestrator = new MessageOrchestrator(llm, data);

    const result = await orchestrator.process(makeInput('what time is it?'));

    // Built-in handler should respond directly
    expect(result.response.skillId).toBe('builtin-time');
    expect(result.response.content).toMatch(/It's \*\*/);
    // Main LLM should NOT be called for built-in skills
    // (memory extraction may still call LLM as a side effect)
    expect(getMainLLMCalls(llm)).toBe(0);
  });

  it('built-in skills are merged with DB skills for matching', async () => {
    const skills = [makeSkill('Order Tracker', ['new order'])];
    const llm = mockLLM();
    const data = mockDataLoader(skills);
    const orchestrator = new MessageOrchestrator(llm, data);

    // This should match the built-in time skill, not the order tracker
    const result = await orchestrator.process(makeInput('what time is it?'));
    expect(result.response.skillId).toBe('builtin-time');

    // This should match the user's order tracker skill
    const result2 = await orchestrator.process(makeInput('new order for Maria'));
    expect(result2.response.skillId).toBe('skill-Order Tracker');
    expect(getMainLLMCalls(llm)).toBe(1); // only for the order (not for built-in time)
  });

  it('non-built-in skill still goes through LLM flow', async () => {
    const skills = [makeSkill('Order Tracker', ['new order'])];
    const llm = mockLLM();
    const data = mockDataLoader(skills);
    const orchestrator = new MessageOrchestrator(llm, data);

    const result = await orchestrator.process(makeInput('new order for Maria'));

    expect(result.response.skillId).toBe('skill-Order Tracker');
    expect(getMainLLMCalls(llm)).toBe(1);
  });
});
