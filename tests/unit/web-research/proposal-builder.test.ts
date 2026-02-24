import { describe, it, expect } from 'vitest';
import { buildToolProposal, buildLearningProposal } from '../../../src/web-research/proposal-builder.js';
import type { LLMGatewayPort } from '../../../src/bot-runtime/orchestrator/message-orchestrator.js';
import type { Prompt, LLMResponse } from '../../../src/common/types/orchestrator.js';
import type { ExtractedApiInfo } from '../../../src/web-research/types.js';

function makeExtractedApi(overrides: Partial<ExtractedApiInfo> = {}): ExtractedApiInfo {
  return {
    serviceName: 'Canva',
    baseUrl: 'https://api.canva.com/v1',
    authType: 'bearer',
    authInstructions: 'Get API key at developers.canva.com',
    endpoints: [
      { path: '/designs', method: 'POST', description: 'Create a design', parameters: { type: 'object' }, responseSchema: null },
      { path: '/designs/{id}', method: 'GET', description: 'Get a design', parameters: { type: 'object' }, responseSchema: null },
      { path: '/designs/{id}/export', method: 'POST', description: 'Export a design', parameters: { type: 'object' }, responseSchema: null },
    ],
    rateLimits: '100 req/min',
    confidence: 0.85,
    ...overrides,
  };
}

function makeMockLlm(response: Partial<LLMResponse>): LLMGatewayPort {
  return {
    complete: async (_prompt: Prompt, _options: { taskType: string; streaming: boolean }) => ({
      content: '',
      toolCalls: [],
      model: 'mock-model',
      usage: { promptTokens: 100, completionTokens: 50 },
      latencyMs: 100,
      ...response,
    }),
  };
}

describe('buildToolProposal', () => {
  it('normalizes service name to lowercase snake_case', () => {
    const proposal = buildToolProposal(makeExtractedApi({ serviceName: 'Google Sheets' }));
    expect(proposal.name).toBe('google_sheets');
  });

  it('maps endpoints from ExtractedApiInfo', () => {
    const proposal = buildToolProposal(makeExtractedApi());
    expect(proposal.endpoints).toHaveLength(3);
    expect(proposal.endpoints[0].path).toBe('/designs');
    expect(proposal.endpoints[0].method).toBe('POST');
    expect(proposal.endpoints[0].description).toBe('Create a design');
  });

  it('copies baseUrl and authType', () => {
    const proposal = buildToolProposal(makeExtractedApi());
    expect(proposal.baseUrl).toBe('https://api.canva.com/v1');
    expect(proposal.authType).toBe('bearer');
  });

  it('generates description from service name', () => {
    const proposal = buildToolProposal(makeExtractedApi());
    expect(proposal.description).toBe('Canva API integration');
  });

  it('handles single-word service names', () => {
    const proposal = buildToolProposal(makeExtractedApi({ serviceName: 'Stripe' }));
    expect(proposal.name).toBe('stripe');
  });

  it('strips special characters from name', () => {
    const proposal = buildToolProposal(makeExtractedApi({ serviceName: 'My-API.io' }));
    expect(proposal.name).toBe('my_api_io');
  });
});

describe('buildLearningProposal', () => {
  it('combines tool and skill proposals', async () => {
    const llm = makeMockLlm({
      toolCalls: [{
        toolName: 'output_skills',
        arguments: {
          skills: [
            {
              name: 'Create Design',
              description: 'Create a new design in Canva',
              triggerPatterns: ['create a poster', 'make a design', 'new flyer'],
              behaviorPrompt: 'Use POST /designs to create a new design',
              outputFormat: 'text',
            },
            {
              name: 'Export Design',
              description: 'Export a design to PDF or PNG',
              triggerPatterns: ['export to pdf', 'download as png', 'save design'],
              behaviorPrompt: 'Use POST /designs/{id}/export to export',
              outputFormat: 'text',
            },
          ],
        },
      }],
    });

    const result = await buildLearningProposal(llm, makeExtractedApi(), ['https://docs.canva.com']);

    expect(result.serviceName).toBe('Canva');
    expect(result.toolProposal.name).toBe('canva');
    expect(result.skillProposals).toHaveLength(2);
    expect(result.skillProposals[0].name).toBe('Create Design');
    expect(result.skillProposals[0].requiredIntegrations).toEqual(['canva']);
    expect(result.skillProposals[1].requiredIntegrations).toEqual(['canva']);
    expect(result.sourceUrls).toEqual(['https://docs.canva.com']);
    expect(result.confidence).toBe(0.85);
    expect(result.authInstructions).toContain('developers.canva.com');
  });

  it('sets requiredIntegrations on all skills', async () => {
    const llm = makeMockLlm({
      toolCalls: [{
        toolName: 'output_skills',
        arguments: {
          skills: [
            { name: 'List Items', description: 'List items', triggerPatterns: ['show items'], behaviorPrompt: 'Use GET /items' },
          ],
        },
      }],
    });

    const result = await buildLearningProposal(
      llm,
      makeExtractedApi({ serviceName: 'My Store' }),
      [],
    );

    expect(result.skillProposals[0].requiredIntegrations).toEqual(['my_store']);
  });

  it('throws when LLM produces no skills', async () => {
    const llm = makeMockLlm({
      content: 'I could not determine any skills.',
      toolCalls: [],
    });

    await expect(buildLearningProposal(llm, makeExtractedApi(), []))
      .rejects.toThrow('did not produce valid skill proposals');
  });

  it('defaults outputFormat to text', async () => {
    const llm = makeMockLlm({
      toolCalls: [{
        toolName: 'output_skills',
        arguments: {
          skills: [
            { name: 'Test', description: 'Test', triggerPatterns: ['test'], behaviorPrompt: 'test' },
          ],
        },
      }],
    });

    const result = await buildLearningProposal(llm, makeExtractedApi(), []);
    expect(result.skillProposals[0].outputFormat).toBe('text');
  });

  it('throws when LLM call fails', async () => {
    const llm: LLMGatewayPort = {
      complete: async () => { throw new Error('LLM down'); },
    };

    await expect(buildLearningProposal(llm, makeExtractedApi(), []))
      .rejects.toThrow('LLM call failed');
  });
});
