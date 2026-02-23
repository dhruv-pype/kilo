import { describe, it, expect } from 'vitest';
import { composeSkillPrompt, buildApiTools } from '@bot-runtime/prompt-composer/prompt-composer.js';
import type { CompositionInput } from '@common/types/orchestrator.js';
import type { SkillDefinition } from '@common/types/skill.js';
import type { ToolRegistryEntry, ToolEndpoint } from '@common/types/tool-registry.js';
import type { BotId, MessageId, SessionId, SkillId, UserId, ToolRegistryId } from '@common/types/ids.js';

// ─── Factories ──────────────────────────────────────────────────

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    skillId: 'skill-1' as SkillId,
    botId: 'bot-1' as BotId,
    name: 'Create Design',
    description: 'Create designs using Canva API',
    triggerPatterns: ['create a poster', 'make a design'],
    behaviorPrompt: 'Help the user create designs via Canva.',
    inputSchema: null,
    outputFormat: 'text',
    schedule: null,
    dataTable: null,
    readableTables: [],
    tableSchema: null,
    requiredIntegrations: ['canva'],
    createdBy: 'user_conversation',
    version: 1,
    performanceScore: 0.5,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeEndpoint(overrides: Partial<ToolEndpoint> = {}): ToolEndpoint {
  return {
    path: '/v1/designs',
    method: 'POST',
    description: 'Create a new design',
    parameters: { type: 'object', properties: { title: { type: 'string' } } },
    responseSchema: null,
    ...overrides,
  };
}

function makeTool(overrides: Partial<ToolRegistryEntry> = {}): ToolRegistryEntry {
  return {
    toolId: 'tool-1' as ToolRegistryId,
    botId: 'bot-1' as BotId,
    name: 'canva',
    description: 'Canva design platform',
    baseUrl: 'https://api.canva.com',
    authType: 'bearer',
    authConfig: {
      encrypted: { iv: 'aabbcc', authTag: 'ddeeff', ciphertext: '112233' },
    },
    endpoints: [makeEndpoint()],
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
      content: 'Create a poster for my bakery',
      attachments: [],
      timestamp: new Date(),
    },
    conversationHistory: [],
    memoryContext: [],
    ragResults: [],
    skillData: { tableName: '', rows: [], totalCount: 0 },
    tableSchemas: [],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('buildApiTools', () => {
  it('returns empty array when no tools provided', () => {
    const result = buildApiTools([]);
    expect(result).toHaveLength(0);
  });

  it('returns a call_api tool definition', () => {
    const tools = buildApiTools([makeTool()]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('call_api');
  });

  it('includes endpoint catalog in description', () => {
    const tools = buildApiTools([makeTool()]);
    expect(tools[0].description).toContain('canva');
    expect(tools[0].description).toContain('POST /v1/designs');
    expect(tools[0].description).toContain('Create a new design');
  });

  it('constrains tool names in parameters', () => {
    const tools = buildApiTools([
      makeTool({ name: 'canva' }),
      makeTool({ name: 'stripe', endpoints: [makeEndpoint({ path: '/v1/charges', method: 'POST', description: 'Create charge' })] }),
    ]);
    const params = tools[0].parameters as Record<string, unknown>;
    const properties = params.properties as Record<string, { enum?: string[] }>;
    expect(properties.tool.enum).toContain('canva');
    expect(properties.tool.enum).toContain('stripe');
  });

  it('constrains HTTP methods in parameters', () => {
    const tools = buildApiTools([
      makeTool({ endpoints: [
        makeEndpoint({ method: 'POST' }),
        makeEndpoint({ method: 'GET', path: '/v1/designs/:id', description: 'Get design' }),
      ] }),
    ]);
    const params = tools[0].parameters as Record<string, unknown>;
    const properties = params.properties as Record<string, { enum?: string[] }>;
    expect(properties.method.enum).toContain('POST');
    expect(properties.method.enum).toContain('GET');
  });

  it('includes multiple endpoints from multiple tools', () => {
    const tools = buildApiTools([
      makeTool({
        name: 'canva',
        endpoints: [
          makeEndpoint({ path: '/v1/designs', method: 'POST', description: 'Create design' }),
          makeEndpoint({ path: '/v1/exports', method: 'POST', description: 'Export design' }),
        ],
      }),
      makeTool({
        name: 'stripe',
        endpoints: [
          makeEndpoint({ path: '/v1/charges', method: 'POST', description: 'Create charge' }),
        ],
      }),
    ]);
    expect(tools[0].description).toContain('/v1/designs');
    expect(tools[0].description).toContain('/v1/exports');
    expect(tools[0].description).toContain('/v1/charges');
  });
});

describe('composeSkillPrompt with apiTools', () => {
  it('includes API integrations section in system prompt', () => {
    const result = composeSkillPrompt(makeCompositionInput({
      apiTools: [makeTool()],
    }));
    expect(result.system).toContain('AVAILABLE API INTEGRATIONS');
    expect(result.system).toContain('CANVA');
    expect(result.system).toContain('https://api.canva.com');
  });

  it('includes endpoint details in system prompt', () => {
    const result = composeSkillPrompt(makeCompositionInput({
      apiTools: [makeTool()],
    }));
    expect(result.system).toContain('POST /v1/designs');
    expect(result.system).toContain('Create a new design');
  });

  it('adds call_api tool to tools array', () => {
    const result = composeSkillPrompt(makeCompositionInput({
      apiTools: [makeTool()],
    }));
    const callApiTool = result.tools.find((t) => t.name === 'call_api');
    expect(callApiTool).toBeDefined();
    expect(callApiTool!.description).toContain('canva');
  });

  it('does not add API section when no apiTools', () => {
    const result = composeSkillPrompt(makeCompositionInput());
    expect(result.system).not.toContain('AVAILABLE API INTEGRATIONS');
    expect(result.tools.some((t) => t.name === 'call_api')).toBe(false);
  });

  it('does not add API section when apiTools is empty array', () => {
    const result = composeSkillPrompt(makeCompositionInput({
      apiTools: [],
    }));
    expect(result.system).not.toContain('AVAILABLE API INTEGRATIONS');
    expect(result.tools.some((t) => t.name === 'call_api')).toBe(false);
  });

  it('includes call_api usage instructions in system prompt', () => {
    const result = composeSkillPrompt(makeCompositionInput({
      apiTools: [makeTool()],
    }));
    expect(result.system).toContain('call_api tool');
    expect(result.system).toContain('Never fabricate API endpoints');
  });

  it('preserves existing skill tools alongside API tools', () => {
    const result = composeSkillPrompt(makeCompositionInput({
      skill: makeSkill({ dataTable: 'designs', readableTables: [] }),
      apiTools: [makeTool()],
    }));
    // Should have both data tools and API tools
    expect(result.tools.some((t) => t.name === 'query_skill_data')).toBe(true);
    expect(result.tools.some((t) => t.name === 'insert_skill_data')).toBe(true);
    expect(result.tools.some((t) => t.name === 'call_api')).toBe(true);
    expect(result.tools.some((t) => t.name === 'schedule_notification')).toBe(true);
  });
});
