import { describe, it, expect } from 'vitest';
import { analyzeApiDocs, composeLearningExtractionPrompt } from '../../../src/web-research/doc-analyzer.js';
import type { LLMGatewayPort } from '../../../src/bot-runtime/orchestrator/message-orchestrator.js';
import type { Prompt, LLMResponse } from '../../../src/common/types/orchestrator.js';
import type { FetchedPage } from '../../../src/web-research/types.js';

function makePage(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: 'https://developer.example.com/docs/api',
    title: 'Example API Reference',
    textContent: 'Base URL: https://api.example.com/v1. Authentication: Bearer token. POST /items - Create an item. GET /items - List items.',
    codeBlocks: ['curl -X POST https://api.example.com/v1/items -H "Authorization: Bearer TOKEN"'],
    truncated: false,
    fetchedAt: new Date(),
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

describe('composeLearningExtractionPrompt', () => {
  it('includes service name in system prompt', () => {
    const prompt = composeLearningExtractionPrompt('Canva', 'Some docs', []);
    expect(prompt.system).toContain('Canva');
  });

  it('includes docs context in user message', () => {
    const prompt = composeLearningExtractionPrompt('Stripe', 'Stripe API v1 documentation', []);
    expect(prompt.messages[0].content).toContain('Stripe API v1 documentation');
  });

  it('includes code blocks when provided', () => {
    const prompt = composeLearningExtractionPrompt('Stripe', 'Docs', ['curl -X POST /charges']);
    expect(prompt.messages[0].content).toContain('curl -X POST /charges');
  });

  it('defines output_api_info tool', () => {
    const prompt = composeLearningExtractionPrompt('Stripe', 'Docs', []);
    expect(prompt.tools).toHaveLength(1);
    expect(prompt.tools[0].name).toBe('output_api_info');
    expect(prompt.tools[0].parameters).toBeDefined();
  });

  it('requires key fields in tool schema', () => {
    const prompt = composeLearningExtractionPrompt('Stripe', 'Docs', []);
    const schema = prompt.tools[0].parameters as Record<string, unknown>;
    const required = schema.required as string[];
    expect(required).toContain('baseUrl');
    expect(required).toContain('endpoints');
    expect(required).toContain('authType');
    expect(required).toContain('confidence');
  });
});

describe('analyzeApiDocs', () => {
  it('parses tool call output from LLM', async () => {
    const llm = makeMockLlm({
      toolCalls: [{
        toolName: 'output_api_info',
        arguments: {
          serviceName: 'Example',
          baseUrl: 'https://api.example.com/v1',
          authType: 'bearer',
          authInstructions: 'Get a token at example.com/tokens',
          endpoints: [
            { path: '/items', method: 'GET', description: 'List items', parameters: { type: 'object' } },
            { path: '/items', method: 'POST', description: 'Create item', parameters: { type: 'object' } },
          ],
          rateLimits: '100 req/min',
          confidence: 0.9,
        },
      }],
    });

    const result = await analyzeApiDocs(llm, 'Example', [makePage()]);

    expect(result.serviceName).toBe('Example');
    expect(result.baseUrl).toBe('https://api.example.com/v1');
    expect(result.authType).toBe('bearer');
    expect(result.endpoints).toHaveLength(2);
    expect(result.endpoints[0].method).toBe('GET');
    expect(result.confidence).toBe(0.9);
    expect(result.rateLimits).toBe('100 req/min');
  });

  it('normalizes endpoint methods to uppercase', async () => {
    const llm = makeMockLlm({
      toolCalls: [{
        toolName: 'output_api_info',
        arguments: {
          serviceName: 'Test',
          baseUrl: 'https://api.test.com',
          authType: 'api_key',
          authInstructions: 'Get key',
          endpoints: [
            { path: '/data', method: 'get', description: 'Get data', parameters: {} },
            { path: '/data', method: 'post', description: 'Post data', parameters: {} },
          ],
          confidence: 0.8,
        },
      }],
    });

    const result = await analyzeApiDocs(llm, 'Test', [makePage()]);
    expect(result.endpoints[0].method).toBe('GET');
    expect(result.endpoints[1].method).toBe('POST');
  });

  it('strips trailing slash from baseUrl', async () => {
    const llm = makeMockLlm({
      toolCalls: [{
        toolName: 'output_api_info',
        arguments: {
          serviceName: 'Test',
          baseUrl: 'https://api.test.com/v1/',
          authType: 'bearer',
          authInstructions: 'Get token',
          endpoints: [{ path: '/x', method: 'GET', description: 'X', parameters: {} }],
          confidence: 0.7,
        },
      }],
    });

    const result = await analyzeApiDocs(llm, 'Test', [makePage()]);
    expect(result.baseUrl).toBe('https://api.test.com/v1');
  });

  it('falls back to JSON in content when no tool call', async () => {
    const llm = makeMockLlm({
      content: `Here's the API info: {"serviceName":"Fallback","baseUrl":"https://api.fb.com","authType":"api_key","authInstructions":"Get key","endpoints":[{"path":"/users","method":"GET","description":"List users","parameters":{}}],"confidence":0.6}`,
      toolCalls: [],
    });

    const result = await analyzeApiDocs(llm, 'Fallback', [makePage()]);
    expect(result.serviceName).toBe('Fallback');
    expect(result.baseUrl).toBe('https://api.fb.com');
    expect(result.endpoints).toHaveLength(1);
  });

  it('throws when LLM returns no parseable output', async () => {
    const llm = makeMockLlm({
      content: 'I could not find any API information.',
      toolCalls: [],
    });

    await expect(analyzeApiDocs(llm, 'Unknown', [makePage()]))
      .rejects.toThrow('did not produce parseable');
  });

  it('throws when baseUrl is missing', async () => {
    const llm = makeMockLlm({
      toolCalls: [{
        toolName: 'output_api_info',
        arguments: {
          serviceName: 'Test',
          baseUrl: '',
          authType: 'bearer',
          authInstructions: 'Get token',
          endpoints: [{ path: '/x', method: 'GET', description: 'X', parameters: {} }],
          confidence: 0.5,
        },
      }],
    });

    await expect(analyzeApiDocs(llm, 'Test', [makePage()]))
      .rejects.toThrow('missing base URL');
  });

  it('throws when endpoints array is empty', async () => {
    const llm = makeMockLlm({
      toolCalls: [{
        toolName: 'output_api_info',
        arguments: {
          serviceName: 'Test',
          baseUrl: 'https://api.test.com',
          authType: 'bearer',
          authInstructions: 'Get token',
          endpoints: [],
          confidence: 0.3,
        },
      }],
    });

    await expect(analyzeApiDocs(llm, 'Test', [makePage()]))
      .rejects.toThrow('no endpoints');
  });

  it('clamps confidence to 0-1 range', async () => {
    const llm = makeMockLlm({
      toolCalls: [{
        toolName: 'output_api_info',
        arguments: {
          serviceName: 'Test',
          baseUrl: 'https://api.test.com',
          authType: 'bearer',
          authInstructions: 'Get token',
          endpoints: [{ path: '/x', method: 'GET', description: 'X', parameters: {} }],
          confidence: 5.0,
        },
      }],
    });

    const result = await analyzeApiDocs(llm, 'Test', [makePage()]);
    expect(result.confidence).toBe(1);
  });

  it('defaults to bearer auth when authType is invalid', async () => {
    const llm = makeMockLlm({
      toolCalls: [{
        toolName: 'output_api_info',
        arguments: {
          serviceName: 'Test',
          baseUrl: 'https://api.test.com',
          authType: 'invalid_type',
          authInstructions: 'Get token',
          endpoints: [{ path: '/x', method: 'GET', description: 'X', parameters: {} }],
          confidence: 0.5,
        },
      }],
    });

    const result = await analyzeApiDocs(llm, 'Test', [makePage()]);
    expect(result.authType).toBe('bearer');
  });

  it('uses fallback service name when not provided by LLM', async () => {
    const llm = makeMockLlm({
      toolCalls: [{
        toolName: 'output_api_info',
        arguments: {
          serviceName: '',
          baseUrl: 'https://api.test.com',
          authType: 'bearer',
          authInstructions: 'Get token',
          endpoints: [{ path: '/x', method: 'GET', description: 'X', parameters: {} }],
          confidence: 0.5,
        },
      }],
    });

    const result = await analyzeApiDocs(llm, 'MyService', [makePage()]);
    expect(result.serviceName).toBe('MyService');
  });

  it('throws when LLM call fails', async () => {
    const llm: LLMGatewayPort = {
      complete: async () => { throw new Error('LLM provider down'); },
    };

    await expect(analyzeApiDocs(llm, 'Test', [makePage()]))
      .rejects.toThrow('LLM call failed');
  });
});
