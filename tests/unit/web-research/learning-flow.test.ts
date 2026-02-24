import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMGatewayPort } from '../../../src/bot-runtime/orchestrator/message-orchestrator.js';
import type { Prompt, LLMResponse } from '../../../src/common/types/orchestrator.js';
import type { BotId } from '../../../src/common/types/ids.js';

// We mock the sub-modules so the learning flow test is isolated
vi.mock('../../../src/web-research/brave-search.js');
vi.mock('../../../src/web-research/page-fetcher.js');
vi.mock('../../../src/web-research/doc-analyzer.js');
vi.mock('../../../src/web-research/proposal-builder.js');

import { executeLearningFlow } from '../../../src/web-research/learning-flow.js';
import { searchForApiDocs } from '../../../src/web-research/brave-search.js';
import { fetchPages } from '../../../src/web-research/page-fetcher.js';
import { analyzeApiDocs } from '../../../src/web-research/doc-analyzer.js';
import { buildLearningProposal } from '../../../src/web-research/proposal-builder.js';
import { WebResearchError } from '../../../src/common/errors/index.js';

const mockedSearch = vi.mocked(searchForApiDocs);
const mockedFetchPages = vi.mocked(fetchPages);
const mockedAnalyze = vi.mocked(analyzeApiDocs);
const mockedBuildProposal = vi.mocked(buildLearningProposal);

function makeMockLlm(): LLMGatewayPort {
  return {
    complete: async (_prompt: Prompt, _options: { taskType: string; streaming: boolean }): Promise<LLMResponse> => ({
      content: '',
      toolCalls: [],
      model: 'mock',
      usage: { promptTokens: 0, completionTokens: 0 },
      latencyMs: 0,
    }),
  };
}

describe('executeLearningFlow', () => {
  const llm = makeMockLlm();
  const input = {
    botId: 'bot-123' as BotId,
    userMessage: 'Learn how to use Canva',
    serviceName: 'Canva',
  };

  let originalApiKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalApiKey = process.env.BRAVE_SEARCH_API_KEY;
    process.env.BRAVE_SEARCH_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = originalApiKey;
    }
  });

  it('runs full happy path: search → fetch → analyze → propose', async () => {
    mockedSearch.mockResolvedValue({
      results: [
        { title: 'Canva API', url: 'https://docs.canva.com/api', snippet: 'API ref', isApiDoc: true },
        { title: 'Blog', url: 'https://canva.com/blog', snippet: 'Blog', isApiDoc: false },
      ],
      query: 'Canva API documentation',
    });

    mockedFetchPages.mockResolvedValue([{
      url: 'https://docs.canva.com/api',
      title: 'Canva API Ref',
      textContent: 'API docs text',
      codeBlocks: [],
      truncated: false,
      fetchedAt: new Date(),
    }]);

    mockedAnalyze.mockResolvedValue({
      serviceName: 'Canva',
      baseUrl: 'https://api.canva.com/v1',
      authType: 'bearer',
      authInstructions: 'Get token at canva.com',
      endpoints: [
        { path: '/designs', method: 'POST', description: 'Create', parameters: {}, responseSchema: null },
      ],
      rateLimits: null,
      confidence: 0.9,
    });

    mockedBuildProposal.mockResolvedValue({
      serviceName: 'Canva',
      toolProposal: {
        name: 'canva',
        description: 'Canva API integration',
        baseUrl: 'https://api.canva.com/v1',
        authType: 'bearer',
        endpoints: [],
      },
      skillProposals: [{
        name: 'Create Design',
        description: 'Create a design in Canva',
        triggerPatterns: ['create a poster'],
        behaviorPrompt: 'Use POST /designs',
        requiredIntegrations: ['canva'],
        outputFormat: 'text',
      }],
      authInstructions: 'Get token at canva.com',
      sourceUrls: ['https://docs.canva.com/api'],
      confidence: 0.9,
    });

    const result = await executeLearningFlow(llm, input);

    expect(result.proposal.serviceName).toBe('Canva');
    expect(result.proposal.skillProposals).toHaveLength(1);
    expect(result.progressLog.length).toBeGreaterThanOrEqual(4);
    expect(result.progressLog[0].stage).toBe('searching');
    expect(result.progressLog[result.progressLog.length - 1].stage).toBe('complete');

    // Verify call order
    expect(mockedSearch).toHaveBeenCalledWith('Canva');
    expect(mockedFetchPages).toHaveBeenCalled();
    expect(mockedAnalyze).toHaveBeenCalled();
    expect(mockedBuildProposal).toHaveBeenCalled();
  });

  it('throws when search returns 0 results', async () => {
    mockedSearch.mockResolvedValue({ results: [], query: 'Canva API' });

    await expect(executeLearningFlow(llm, input))
      .rejects.toThrow('No documentation found');
  });

  it('throws when all page fetches fail', async () => {
    mockedSearch.mockResolvedValue({
      results: [{ title: 'A', url: 'https://a.com', snippet: '', isApiDoc: true }],
      query: 'Canva API',
    });
    mockedFetchPages.mockResolvedValue([]);

    await expect(executeLearningFlow(llm, input))
      .rejects.toThrow('Could not read any documentation');
  });

  it('throws when no endpoints are extracted', async () => {
    mockedSearch.mockResolvedValue({
      results: [{ title: 'A', url: 'https://a.com', snippet: '', isApiDoc: true }],
      query: 'Canva API',
    });
    mockedFetchPages.mockResolvedValue([{
      url: 'https://a.com', title: 'A', textContent: 'text', codeBlocks: [],
      truncated: false, fetchedAt: new Date(),
    }]);
    mockedAnalyze.mockResolvedValue({
      serviceName: 'Canva', baseUrl: 'https://api.canva.com', authType: 'bearer',
      authInstructions: '', endpoints: [], rateLimits: null, confidence: 0.1,
    });

    await expect(executeLearningFlow(llm, input))
      .rejects.toThrow('Could not extract any API endpoints');
  });

  it('prioritizes API doc URLs in fetch order', async () => {
    mockedSearch.mockResolvedValue({
      results: [
        { title: 'Blog', url: 'https://blog.com', snippet: '', isApiDoc: false },
        { title: 'API Docs', url: 'https://api.com/docs', snippet: '', isApiDoc: true },
      ],
      query: 'Canva API',
    });
    mockedFetchPages.mockResolvedValue([{
      url: 'https://api.com/docs', title: 'API', textContent: 'text', codeBlocks: [],
      truncated: false, fetchedAt: new Date(),
    }]);
    mockedAnalyze.mockResolvedValue({
      serviceName: 'Canva', baseUrl: 'https://api.canva.com', authType: 'bearer',
      authInstructions: '', endpoints: [{ path: '/x', method: 'GET', description: '', parameters: {}, responseSchema: null }],
      rateLimits: null, confidence: 0.8,
    });
    mockedBuildProposal.mockResolvedValue({
      serviceName: 'Canva', toolProposal: { name: 'canva', description: '', baseUrl: '', authType: 'bearer', endpoints: [] },
      skillProposals: [{ name: 'S', description: '', triggerPatterns: [], behaviorPrompt: '', requiredIntegrations: ['canva'], outputFormat: 'text' }],
      authInstructions: '', sourceUrls: [], confidence: 0.8,
    });

    await executeLearningFlow(llm, input);

    // The first URL passed to fetchPages should be the API doc
    const fetchCall = mockedFetchPages.mock.calls[0];
    expect(fetchCall[0][0]).toBe('https://api.com/docs');
  });

  it('records progress at each stage', async () => {
    mockedSearch.mockResolvedValue({
      results: [{ title: 'A', url: 'https://a.com', snippet: '', isApiDoc: true }],
      query: 'q',
    });
    mockedFetchPages.mockResolvedValue([{
      url: 'https://a.com', title: 'A', textContent: 'text', codeBlocks: [],
      truncated: false, fetchedAt: new Date(),
    }]);
    mockedAnalyze.mockResolvedValue({
      serviceName: 'Canva', baseUrl: 'https://api.canva.com', authType: 'bearer',
      authInstructions: '', endpoints: [{ path: '/x', method: 'GET', description: '', parameters: {}, responseSchema: null }],
      rateLimits: null, confidence: 0.8,
    });
    mockedBuildProposal.mockResolvedValue({
      serviceName: 'Canva', toolProposal: { name: 'canva', description: '', baseUrl: '', authType: 'bearer', endpoints: [] },
      skillProposals: [{ name: 'S', description: '', triggerPatterns: [], behaviorPrompt: '', requiredIntegrations: ['canva'], outputFormat: 'text' }],
      authInstructions: '', sourceUrls: [], confidence: 0.8,
    });

    const result = await executeLearningFlow(llm, input);
    const stages = result.progressLog.map((e) => e.stage);
    expect(stages).toEqual(['searching', 'fetching', 'analyzing', 'proposing', 'complete']);
  });

  it('propagates WebResearchError from sub-modules', async () => {
    mockedSearch.mockRejectedValue(new WebResearchError('API key missing', 'searching'));

    await expect(executeLearningFlow(llm, input))
      .rejects.toThrow('API key missing');
  });
});
