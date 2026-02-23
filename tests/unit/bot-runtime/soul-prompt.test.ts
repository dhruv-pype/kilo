import { describe, it, expect } from 'vitest';
import { composeSoulSection, composeSkillPrompt, composeGeneralPrompt } from '@bot-runtime/prompt-composer/prompt-composer.js';
import type { SoulDefinition } from '@common/types/soul.js';
import type { CompositionInput, GeneralCompositionInput } from '@common/types/orchestrator.js';
import type { SkillDefinition } from '@common/types/skill.js';
import type { BotId, MessageId, SessionId, SkillId, UserId } from '@common/types/ids.js';

// ─── Fixtures ─────────────────────────────────────────────────

function makeSoul(overrides: Partial<SoulDefinition> = {}): SoulDefinition {
  return {
    personalityTraits: {
      tone: 'warm and encouraging',
      energy: 'patient',
      patterns: ['Uses metaphors', 'Asks clarifying questions'],
    },
    values: {
      priorities: ['Customer satisfaction above efficiency'],
      beliefs: ['Honesty even when the answer is "I don\'t know"'],
    },
    communicationStyle: {
      verbosity: 'concise',
      formality: 'casual',
      formatting: ['Always use bullet points for lists'],
    },
    behavioralRules: {
      always: ['Greet by name', 'Confirm before taking action'],
      never: ['Give medical advice', 'Share other customers\' data'],
      guardrails: ['If unsure about pricing, say "let me check"'],
    },
    decisionFramework: {
      ambiguity: 'Ask one clarifying question, then proceed',
      conflictResolution: 'Prioritize user safety over convenience',
      escalation: 'Suggest contacting owner for refund requests over $100',
    },
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    skillId: 'skill-1' as SkillId,
    botId: 'bot-1' as BotId,
    name: 'Order Tracker',
    description: 'Track customer orders',
    triggerPatterns: ['new order'],
    behaviorPrompt: 'You help track bakery orders.',
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
    ...overrides,
  };
}

function makeMessage(content = 'Hello') {
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

// ─── composeSoulSection ───────────────────────────────────────

describe('composeSoulSection', () => {
  it('renders all five soul layers', () => {
    const result = composeSoulSection(makeSoul());

    expect(result).toContain('PERSONALITY:');
    expect(result).toContain('VALUES & PRINCIPLES:');
    expect(result).toContain('COMMUNICATION STYLE:');
    expect(result).toContain('BEHAVIORAL RULES:');
    expect(result).toContain('DECISION FRAMEWORK:');
  });

  it('renders personality traits', () => {
    const result = composeSoulSection(makeSoul());

    expect(result).toContain('Tone: warm and encouraging');
    expect(result).toContain('Energy: patient');
    expect(result).toContain('Patterns: Uses metaphors, Asks clarifying questions');
  });

  it('renders values and principles', () => {
    const result = composeSoulSection(makeSoul());

    expect(result).toContain('Customer satisfaction above efficiency');
    expect(result).toContain('Honesty even when the answer is');
  });

  it('renders communication style', () => {
    const result = composeSoulSection(makeSoul());

    expect(result).toContain('Verbosity: concise');
    expect(result).toContain('Formality: casual');
    expect(result).toContain('Always use bullet points for lists');
  });

  it('renders behavioral rules with ALWAYS and NEVER', () => {
    const result = composeSoulSection(makeSoul());

    expect(result).toContain('ALWAYS: Greet by name; Confirm before taking action');
    expect(result).toContain('NEVER: Give medical advice; Share other customers');
  });

  it('renders guardrails', () => {
    const result = composeSoulSection(makeSoul());

    expect(result).toContain('let me check');
  });

  it('renders decision framework', () => {
    const result = composeSoulSection(makeSoul());

    expect(result).toContain('Ambiguity: Ask one clarifying question');
    expect(result).toContain('Conflicts: Prioritize user safety');
    expect(result).toContain('Escalation: Suggest contacting owner');
  });

  it('omits empty patterns gracefully', () => {
    const soul = makeSoul({
      personalityTraits: { tone: 'direct', energy: 'high', patterns: [] },
    });
    const result = composeSoulSection(soul);

    expect(result).toContain('Tone: direct');
    expect(result).not.toContain('Patterns:');
  });

  it('omits VALUES section when both arrays are empty', () => {
    const soul = makeSoul({
      values: { priorities: [], beliefs: [] },
    });
    const result = composeSoulSection(soul);

    expect(result).not.toContain('VALUES & PRINCIPLES:');
  });

  it('omits BEHAVIORAL RULES when all arrays are empty', () => {
    const soul = makeSoul({
      behavioralRules: { always: [], never: [], guardrails: [] },
    });
    const result = composeSoulSection(soul);

    expect(result).not.toContain('BEHAVIORAL RULES:');
  });

  it('omits DECISION FRAMEWORK when all fields are empty', () => {
    const soul = makeSoul({
      decisionFramework: { ambiguity: '', conflictResolution: '', escalation: '' },
    });
    const result = composeSoulSection(soul);

    expect(result).not.toContain('DECISION FRAMEWORK:');
  });
});

// ─── composeGeneralPrompt with soul ───────────────────────────

describe('composeGeneralPrompt with soul', () => {
  it('uses soul sections instead of flat personality when soul is present', () => {
    const input: GeneralCompositionInput = {
      message: makeMessage('How are you?'),
      conversationHistory: [],
      memoryContext: [],
      botConfig: {
        name: 'Sweet Crumb Bot',
        personality: 'This should be ignored',
        context: 'Bakery with 5 employees',
        soul: makeSoul(),
      },
    };

    const result = composeGeneralPrompt(input);

    // Soul sections should be present
    expect(result.system).toContain('PERSONALITY:');
    expect(result.system).toContain('Tone: warm and encouraging');
    expect(result.system).toContain('BEHAVIORAL RULES:');

    // Flat personality should NOT be used when soul is present
    expect(result.system).not.toContain('PERSONALITY: This should be ignored');
  });

  it('still includes context when soul is present', () => {
    const input: GeneralCompositionInput = {
      message: makeMessage(),
      conversationHistory: [],
      memoryContext: [],
      botConfig: {
        name: 'Bot',
        personality: '',
        context: 'We sell cupcakes and custom cakes',
        soul: makeSoul(),
      },
    };

    const result = composeGeneralPrompt(input);

    expect(result.system).toContain('CONTEXT: We sell cupcakes and custom cakes');
  });

  it('falls back to flat personality when soul is null', () => {
    const input: GeneralCompositionInput = {
      message: makeMessage(),
      conversationHistory: [],
      memoryContext: [],
      botConfig: {
        name: 'Flat Bot',
        personality: 'Friendly and helpful',
        context: 'A bakery',
        soul: null,
      },
    };

    const result = composeGeneralPrompt(input);

    // Flat format: "PERSONALITY: Friendly..."
    expect(result.system).toContain('PERSONALITY: Friendly and helpful');
    expect(result.system).toContain('CONTEXT: A bakery');

    // Should NOT have structured soul sections
    expect(result.system).not.toContain('Tone:');
    expect(result.system).not.toContain('BEHAVIORAL RULES:');
  });

  it('includes bot name in system prompt regardless of soul', () => {
    const input: GeneralCompositionInput = {
      message: makeMessage(),
      conversationHistory: [],
      memoryContext: [],
      botConfig: {
        name: 'MegaBot',
        personality: '',
        context: '',
        soul: makeSoul(),
      },
    };

    const result = composeGeneralPrompt(input);
    expect(result.system).toContain('MegaBot');
  });
});

// ─── composeSkillPrompt with soul ─────────────────────────────

describe('composeSkillPrompt with soul', () => {
  it('injects soul before skill instructions', () => {
    const input: CompositionInput = {
      skill: makeSkill(),
      message: makeMessage('New order for Maria'),
      conversationHistory: [],
      memoryContext: [],
      ragResults: [],
      skillData: { tableName: '', rows: [], totalCount: 0 },
      tableSchemas: [],
      soul: makeSoul(),
    };

    const result = composeSkillPrompt(input);

    // Soul sections should appear
    expect(result.system).toContain('PERSONALITY:');
    expect(result.system).toContain('Tone: warm and encouraging');
    expect(result.system).toContain('BEHAVIORAL RULES:');

    // Skill instructions should also appear
    expect(result.system).toContain('ACTIVE SKILL: Order Tracker');
    expect(result.system).toContain('You help track bakery orders.');

    // Soul should come BEFORE skill instructions in the prompt
    const soulIdx = result.system.indexOf('PERSONALITY:');
    const skillIdx = result.system.indexOf('ACTIVE SKILL:');
    expect(soulIdx).toBeLessThan(skillIdx);
  });

  it('works without soul (soul undefined)', () => {
    const input: CompositionInput = {
      skill: makeSkill(),
      message: makeMessage('New order'),
      conversationHistory: [],
      memoryContext: [],
      ragResults: [],
      skillData: { tableName: '', rows: [], totalCount: 0 },
      tableSchemas: [],
      // soul not provided — undefined
    };

    const result = composeSkillPrompt(input);

    // Skill instructions should still work
    expect(result.system).toContain('ACTIVE SKILL: Order Tracker');
    // Should NOT have structured soul sections
    expect(result.system).not.toContain('Tone:');
    expect(result.system).not.toContain('BEHAVIORAL RULES:');
  });

  it('works with soul explicitly set to null', () => {
    const input: CompositionInput = {
      skill: makeSkill(),
      message: makeMessage('Show orders'),
      conversationHistory: [],
      memoryContext: [],
      ragResults: [],
      skillData: { tableName: '', rows: [], totalCount: 0 },
      tableSchemas: [],
      soul: null,
    };

    const result = composeSkillPrompt(input);

    expect(result.system).toContain('ACTIVE SKILL: Order Tracker');
    expect(result.system).not.toContain('Tone:');
  });
});
