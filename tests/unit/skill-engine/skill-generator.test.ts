import { describe, it, expect, vi } from 'vitest';
import { generate, refine } from '../../../src/skill-engine/skill-generator.js';
import type { SkillProposal, LLMResponse, Prompt } from '@common/types/orchestrator.js';
import type { SkillDefinition } from '@common/types/skill.js';
import type { BotId, SkillId } from '@common/types/ids.js';

// ─── Fixtures ──────────────────────────────────────────────────

const STEPS_PROPOSAL: SkillProposal = {
  proposedName: 'Step Tracker',
  description: 'Track daily step counts',
  triggerExamples: ['log my steps', 'I walked 8000 steps'],
  suggestedInputFields: [
    { name: 'steps', type: 'integer', description: 'Number of steps', required: true },
    { name: 'notes', type: 'string', description: 'Optional notes', required: false },
  ],
  suggestedSchedule: null,
  clarifyingQuestions: [],
  confidence: 0.9,
  dataModel: 'daily_total',
};

const GENERATED_RESULT = {
  toolName: 'generate_skill_spec',
  arguments: {
    behaviorPrompt: 'You help track daily steps. Check for existing entry before inserting because daily_total means one row per day. Target date: compute from message ("yesterday" → CURRENT_DATE-1).',
    triggerPatterns: [
      'log steps', 'log my steps', 'walked steps', 'track steps',
      'add steps', 'record steps', 'step count', 'steps today',
    ],
    description: 'Track daily step counts. Use when user mentions walking, steps, or daily activity logging.',
    needsHistory: false,
    needsMemory: false,
    readsData: true,
  },
};

function makeLLM(toolCallArgs = GENERATED_RESULT): { complete: ReturnType<typeof vi.fn> } {
  const response: LLMResponse = {
    content: '',
    toolCalls: [toolCallArgs],
    model: 'claude-sonnet-4-6',
    usage: { promptTokens: 500, completionTokens: 200 },
    latencyMs: 1000,
  };
  return {
    complete: vi.fn().mockResolvedValue(response),
  };
}

function makeSkill(): SkillDefinition {
  return {
    skillId: 'skill-123' as SkillId,
    botId: 'bot-1' as BotId,
    name: 'Step Tracker',
    description: 'Track daily steps',
    triggerPatterns: ['log steps', 'log my steps'],
    behaviorPrompt: 'Old behavior prompt.',
    inputSchema: null,
    outputFormat: 'text',
    schedule: null,
    needsHistory: true,
    needsMemory: false,
    dataTable: 'steps',
    readsData: true,
    readableTables: [],
    tableSchema: null,
    requiredIntegrations: [],
    createdBy: 'auto_proposed',
    version: 1,
    performanceScore: 0.5,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ─── Tests: generate() ─────────────────────────────────────────

describe('SkillGenerator.generate', () => {
  it('calls LLM with skill_generation task type', async () => {
    const llm = makeLLM();
    await generate(STEPS_PROPOSAL, null, llm);

    expect(llm.complete).toHaveBeenCalledOnce();
    const [, options] = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.taskType).toBe('skill_generation');
    expect(options.streaming).toBe(false);
  });

  it('returns the structured result from generate_skill_spec tool call', async () => {
    const llm = makeLLM();
    const result = await generate(STEPS_PROPOSAL, null, llm);

    expect(result.behaviorPrompt).toContain('daily_total');
    expect(result.triggerPatterns).toHaveLength(8);
    expect(result.description).toContain('Use when');
    expect(result.readsData).toBe(true);
    expect(result.needsHistory).toBe(false);
    expect(result.needsMemory).toBe(false);
  });

  it('includes tableSchema DDL in the prompt when provided', async () => {
    const llm = makeLLM();
    const ddl = 'CREATE TABLE steps (\n  id UUID PRIMARY KEY,\n  steps INTEGER NOT NULL\n);';
    await generate(STEPS_PROPOSAL, ddl, llm);

    const [prompt] = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt.messages[0].content).toContain(ddl);
  });

  it('throws when LLM does not call generate_skill_spec', async () => {
    const llm = {
      complete: vi.fn().mockResolvedValue({
        content: 'Sorry I cannot help',
        toolCalls: [],
        model: 'claude-sonnet-4-6',
        usage: { promptTokens: 10, completionTokens: 5 },
        latencyMs: 100,
      }),
    };

    await expect(generate(STEPS_PROPOSAL, null, llm)).rejects.toThrow('generate_skill_spec');
  });

  it('passes the proposal name and data model in the user message', async () => {
    const llm = makeLLM();
    await generate(STEPS_PROPOSAL, null, llm);

    const [prompt] = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    const userMsg = prompt.messages[0].content as string;
    expect(userMsg).toContain('Step Tracker');
    expect(userMsg).toContain('daily_total');
  });

  it('includes generate_skill_spec tool in the prompt tools', async () => {
    const llm = makeLLM();
    await generate(STEPS_PROPOSAL, null, llm);

    const [prompt] = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0] as [Prompt];
    expect(prompt.tools).toHaveLength(1);
    expect(prompt.tools[0].name).toBe('generate_skill_spec');
  });
});

// ─── Tests: refine() ──────────────────────────────────────────

describe('SkillGenerator.refine', () => {
  it('calls LLM with skill_generation task type', async () => {
    const refineResult = {
      ...GENERATED_RESULT,
      arguments: { ...GENERATED_RESULT.arguments, changesSummary: '- Fixed retroactive date handling' },
    };
    const llm = makeLLM(refineResult);
    await refine(makeSkill(), 'Fix retroactive date handling', 'user: I walked 8000 steps yesterday\nassistant: Logged.', llm);

    expect(llm.complete).toHaveBeenCalledOnce();
    const [, options] = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.taskType).toBe('skill_generation');
  });

  it('includes changesSummary in the result', async () => {
    const refineResult = {
      ...GENERATED_RESULT,
      arguments: { ...GENERATED_RESULT.arguments, changesSummary: '- Fixed retroactive date handling\n- Added weekly summary support' },
    };
    const llm = makeLLM(refineResult);
    const result = await refine(makeSkill(), 'fix dates', 'context', llm);

    expect(result.changesSummary).toContain('Fixed retroactive date handling');
  });

  it('includes the current behavior prompt in the user message', async () => {
    const refineResult = {
      ...GENERATED_RESULT,
      arguments: { ...GENERATED_RESULT.arguments, changesSummary: '- Fixed something' },
    };
    const llm = makeLLM(refineResult);
    await refine(makeSkill(), 'improve it', 'context here', llm);

    const [prompt] = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0] as [Prompt];
    const userMsg = prompt.messages[0].content as string;
    expect(userMsg).toContain('Old behavior prompt.');
    expect(userMsg).toContain('context here');
  });
});
