import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BotId, MessageId, SessionId, UserId } from '@common/types/ids.js';
import type { OrchestratorInput } from '@common/types/orchestrator.js';

// Mock the learning modules BEFORE importing the orchestrator
// Partial mock: only mock detectLearningIntent, keep looksLikeServiceName real
vi.mock('../../../src/web-research/learning-detector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web-research/learning-detector.js')>();
  return {
    ...actual,
    detectLearningIntent: vi.fn(),
  };
});
vi.mock('../../../src/web-research/learning-flow.js');

import { MessageOrchestrator } from '@bot-runtime/orchestrator/message-orchestrator.js';
import type { LLMGatewayPort, DataLoaderPort } from '@bot-runtime/orchestrator/message-orchestrator.js';
import { detectLearningIntent } from '../../../src/web-research/learning-detector.js';
import { executeLearningFlow } from '../../../src/web-research/learning-flow.js';
import { WebResearchError } from '../../../src/common/errors/index.js';

const mockedDetect = vi.mocked(detectLearningIntent);
const mockedExecute = vi.mocked(executeLearningFlow);

// ─── Helpers ─────────────────────────────────────────────────────

function mockLLM(): LLMGatewayPort {
  return {
    complete: vi.fn().mockResolvedValue({
      content: 'General response.',
      toolCalls: [],
      model: 'claude-sonnet-4-5-20250929',
      usage: { promptTokens: 100, completionTokens: 50 },
      latencyMs: 500,
    }),
  };
}

function mockDataLoader(): DataLoaderPort {
  return {
    loadBotConfig: vi.fn().mockResolvedValue({
      botId: 'bot-1',
      userId: 'user-1',
      name: 'Test Bot',
      description: 'Test',
      personality: 'Helpful',
      context: '',
      soul: null,
      schemaName: 'bot_test',
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    loadSkills: vi.fn().mockResolvedValue([]),
    loadConversationHistory: vi.fn().mockResolvedValue([]),
    loadMemoryFacts: vi.fn().mockResolvedValue([]),
    loadRAGResults: vi.fn().mockResolvedValue([]),
    loadSkillData: vi.fn().mockResolvedValue({ tableName: '', rows: [], totalCount: 0 }),
    loadTableSchemas: vi.fn().mockResolvedValue([]),
    loadRecentDismissals: vi.fn().mockResolvedValue([]),
    loadTools: vi.fn().mockResolvedValue([]),
  };
}

function makeInput(content: string): OrchestratorInput {
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

function makeLearningProposal() {
  return {
    serviceName: 'Canva',
    toolProposal: {
      name: 'canva',
      description: 'Canva API integration',
      baseUrl: 'https://api.canva.com/v1',
      authType: 'bearer' as const,
      endpoints: [
        { path: '/designs', method: 'POST', description: 'Create a design', parameters: {}, responseSchema: null },
        { path: '/designs', method: 'GET', description: 'List designs', parameters: {}, responseSchema: null },
      ],
    },
    skillProposals: [
      {
        name: 'Create Design',
        description: 'Create a design in Canva',
        triggerPatterns: ['create a poster'],
        behaviorPrompt: 'Use POST /designs',
        requiredIntegrations: ['canva'],
        outputFormat: 'text',
      },
    ],
    authInstructions: 'Get an API key at developers.canva.com',
    sourceUrls: ['https://docs.canva.com/api'],
    confidence: 0.9,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('MessageOrchestrator — learning flow integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no learning intent detected
    mockedDetect.mockReturnValue(null);
  });

  it('short-circuits to learning flow when intent is detected with high confidence', async () => {
    mockedDetect.mockReturnValue({
      serviceName: 'Canva',
      confidence: 0.95,
      originalPhrase: 'learn how to use Canva',
    });
    mockedExecute.mockResolvedValue({
      proposal: makeLearningProposal(),
      progressLog: [
        { stage: 'searching', message: 'Searching...', timestamp: new Date() },
        { stage: 'complete', message: 'Done', timestamp: new Date() },
      ],
    });

    const orchestrator = new MessageOrchestrator(mockLLM(), mockDataLoader());
    const result = await orchestrator.process(makeInput('Learn how to use Canva'));

    // Response should contain the learning proposal
    expect(result.response.content).toContain('Canva');
    expect(result.response.content).toContain('api.canva.com');
    expect(result.response.content).toContain('Create Design');
    expect(result.response.suggestedActions).toContain('Yes, set it up');

    // Side effects should include the learning proposal
    const learnEffect = result.sideEffects.find((e) => e.type === 'learning_proposal');
    expect(learnEffect).toBeDefined();
    if (learnEffect?.type === 'learning_proposal') {
      expect(learnEffect.proposal.serviceName).toBe('Canva');
      expect(learnEffect.proposal.endpointCount).toBe(2);
      expect(learnEffect.proposal.skillCount).toBe(1);
    }

    // LLM should NOT be called for general conversation
    // (executeLearningFlow uses its own LLM calls internally)
    expect(mockedExecute).toHaveBeenCalledOnce();
  });

  it('triggers clarification when confidence is between 0.5 and 0.7', async () => {
    mockedDetect.mockReturnValue({
      serviceName: 'Tell Time',
      confidence: 0.6,
      originalPhrase: 'learn how to tell time',
    });

    const llm = mockLLM();
    const orchestrator = new MessageOrchestrator(llm, mockDataLoader());
    const result = await orchestrator.process(makeInput('Learn how to tell time'));

    // Should NOT call the full learning flow
    expect(mockedExecute).not.toHaveBeenCalled();
    // Should NOT call the LLM for general conversation
    expect(llm.complete).not.toHaveBeenCalled();
    // Should return a clarification response offering to search
    expect(result.response.content).toContain('tell time');
    expect(result.response.content).toContain('search');
  });

  it('does not trigger learning flow when no intent is detected', async () => {
    mockedDetect.mockReturnValue(null);

    const llm = mockLLM();
    const orchestrator = new MessageOrchestrator(llm, mockDataLoader());
    const result = await orchestrator.process(makeInput('Hello, how are you?'));

    expect(mockedExecute).not.toHaveBeenCalled();
    expect(llm.complete).toHaveBeenCalled();
    expect(result.response.content).toBe('General response.');
  });

  it('still extracts memory facts from learning messages', async () => {
    mockedDetect.mockReturnValue({
      serviceName: 'Canva',
      confidence: 0.95,
      originalPhrase: 'learn how to use Canva',
    });
    mockedExecute.mockResolvedValue({
      proposal: makeLearningProposal(),
      progressLog: [],
    });

    const orchestrator = new MessageOrchestrator(mockLLM(), mockDataLoader());
    const result = await orchestrator.process(
      makeInput('My bakery is called Sweet Crumb. Learn how to use Canva'),
    );

    // Should have both learning_proposal and memory_write side effects
    const learnEffect = result.sideEffects.find((e) => e.type === 'learning_proposal');
    expect(learnEffect).toBeDefined();

    const memoryEffect = result.sideEffects.find((e) => e.type === 'memory_write');
    expect(memoryEffect).toBeDefined();
  });

  it('returns friendly error message on WebResearchError', async () => {
    mockedDetect.mockReturnValue({
      serviceName: 'FakeService',
      confidence: 0.95,
      originalPhrase: 'learn how to use FakeService',
    });
    mockedExecute.mockRejectedValue(
      new WebResearchError('No documentation found for FakeService', 'searching'),
    );

    const orchestrator = new MessageOrchestrator(mockLLM(), mockDataLoader());
    const result = await orchestrator.process(makeInput('Learn how to use FakeService'));

    expect(result.response.content).toContain('FakeService');
    expect(result.response.content).toContain('ran into an issue');
    expect(result.response.content).toContain('No documentation found');
    expect(result.response.suggestedActions).toContain('Try again');
  });

  it('re-throws non-WebResearchError exceptions', async () => {
    mockedDetect.mockReturnValue({
      serviceName: 'Canva',
      confidence: 0.95,
      originalPhrase: 'learn how to use Canva',
    });
    mockedExecute.mockRejectedValue(new Error('Unexpected database failure'));

    const orchestrator = new MessageOrchestrator(mockLLM(), mockDataLoader());

    await expect(orchestrator.process(makeInput('Learn how to use Canva')))
      .rejects.toThrow('Unexpected database failure');
  });

  it('formats proposal with endpoint count and auth info', async () => {
    mockedDetect.mockReturnValue({
      serviceName: 'Stripe',
      confidence: 0.9,
      originalPhrase: 'integrate with Stripe',
    });
    const proposal = makeLearningProposal();
    proposal.serviceName = 'Stripe';
    proposal.toolProposal.baseUrl = 'https://api.stripe.com/v1';
    proposal.toolProposal.authType = 'bearer';
    proposal.authInstructions = 'Get your API key at dashboard.stripe.com/apikeys';
    mockedExecute.mockResolvedValue({ proposal, progressLog: [] });

    const orchestrator = new MessageOrchestrator(mockLLM(), mockDataLoader());
    const result = await orchestrator.process(makeInput('Integrate with Stripe'));

    expect(result.response.content).toContain('Stripe');
    expect(result.response.content).toContain('api.stripe.com');
    expect(result.response.content).toContain('bearer auth');
    expect(result.response.content).toContain('2 endpoints');
    expect(result.response.content).toContain('dashboard.stripe.com');
  });

  it('passes botId and serviceName to executeLearningFlow', async () => {
    mockedDetect.mockReturnValue({
      serviceName: 'Notion',
      confidence: 0.9,
      originalPhrase: 'learn how to use Notion',
    });
    mockedExecute.mockResolvedValue({
      proposal: makeLearningProposal(),
      progressLog: [],
    });

    const orchestrator = new MessageOrchestrator(mockLLM(), mockDataLoader());
    await orchestrator.process(makeInput('Learn how to use Notion'));

    expect(mockedExecute).toHaveBeenCalledWith(
      expect.anything(), // LLM gateway
      expect.objectContaining({
        botId: 'bot-1',
        serviceName: 'Notion',
        userMessage: 'Learn how to use Notion',
      }),
    );
  });

  it('learning detection runs before skill matching', async () => {
    // Even if there is a skill that could match, learning intent takes priority
    mockedDetect.mockReturnValue({
      serviceName: 'Canva',
      confidence: 0.95,
      originalPhrase: 'learn how to use Canva',
    });
    mockedExecute.mockResolvedValue({
      proposal: makeLearningProposal(),
      progressLog: [],
    });

    const data = mockDataLoader();
    const orchestrator = new MessageOrchestrator(mockLLM(), data);
    const result = await orchestrator.process(makeInput('Learn how to use Canva'));

    // Should have gone through learning flow, not skill matching
    expect(mockedExecute).toHaveBeenCalledOnce();
    expect(result.sideEffects.find((e) => e.type === 'learning_proposal')).toBeDefined();
  });

  it('confidence exactly 0.7 triggers learning flow', async () => {
    mockedDetect.mockReturnValue({
      serviceName: 'Test',
      confidence: 0.7,
      originalPhrase: 'can you use test',
    });
    mockedExecute.mockResolvedValue({
      proposal: makeLearningProposal(),
      progressLog: [],
    });

    const orchestrator = new MessageOrchestrator(mockLLM(), mockDataLoader());
    const result = await orchestrator.process(makeInput('Can you use test'));

    expect(mockedExecute).toHaveBeenCalledOnce();
    expect(result.sideEffects.find((e) => e.type === 'learning_proposal')).toBeDefined();
  });

  it('confidence 0.69 triggers clarification, not full learning flow', async () => {
    mockedDetect.mockReturnValue({
      serviceName: 'Test',
      confidence: 0.69,
      originalPhrase: 'test phrase',
    });

    const llm = mockLLM();
    const orchestrator = new MessageOrchestrator(llm, mockDataLoader());
    const result = await orchestrator.process(makeInput('test phrase'));

    expect(mockedExecute).not.toHaveBeenCalled();
    // Clarification, not general conversation
    expect(llm.complete).not.toHaveBeenCalled();
    expect(result.response.content).toContain('learn');
  });

  it('confidence below 0.5 falls through to normal flow', async () => {
    mockedDetect.mockReturnValue({
      serviceName: 'Vague',
      confidence: 0.4,
      originalPhrase: 'vague phrase',
    });

    const llm = mockLLM();
    const orchestrator = new MessageOrchestrator(llm, mockDataLoader());
    const result = await orchestrator.process(makeInput('vague phrase'));

    expect(mockedExecute).not.toHaveBeenCalled();
    // Falls through to general conversation
    expect(llm.complete).toHaveBeenCalled();
    expect(result.response.content).toBe('General response.');
  });

  it('clarification for service-like name asks about research', async () => {
    mockedDetect.mockReturnValue({
      serviceName: 'Spotify',
      confidence: 0.6,
      originalPhrase: 'learn Spotify',
    });

    const orchestrator = new MessageOrchestrator(mockLLM(), mockDataLoader());
    const result = await orchestrator.process(makeInput('learn Spotify'));

    expect(result.response.content).toContain('Spotify');
    expect(result.response.content).toContain('search the web');
  });

  it('clarification for capability-like name offers to search proactively', async () => {
    mockedDetect.mockReturnValue({
      serviceName: 'Send Emails',
      confidence: 0.6,
      originalPhrase: 'learn to send emails',
    });

    const orchestrator = new MessageOrchestrator(mockLLM(), mockDataLoader());
    const result = await orchestrator.process(makeInput('learn to send emails'));

    expect(result.response.content).toContain('send emails');
    expect(result.response.content).toContain('search');
    expect(result.response.suggestedActions).toContain('Yes, search for it');
  });

  it('clarification response contains hidden marker for follow-up detection', async () => {
    mockedDetect.mockReturnValue({
      serviceName: 'Tell Time',
      confidence: 0.6,
      originalPhrase: 'learn how to tell time',
    });

    const orchestrator = new MessageOrchestrator(mockLLM(), mockDataLoader());
    const result = await orchestrator.process(makeInput('learn how to tell time'));

    expect(result.response.content).toContain('<!-- learning-clarification:');
    expect(result.response.content).toContain('Tell Time');
  });

  it('follow-up "yes" after clarification triggers learning flow', async () => {
    // Simulate: last bot message was a clarification with marker
    const data = mockDataLoader();
    (data.loadConversationHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        messageId: 'msg-prev' as MessageId,
        sessionId: 'sess-1' as SessionId,
        botId: 'bot-1' as BotId,
        role: 'assistant',
        content: '<!-- learning-clarification:Tell Time -->I can do that! Want me to search?',
        attachments: [],
        skillId: null,
        timestamp: new Date(),
      },
    ]);
    mockedExecute.mockResolvedValue({
      proposal: makeLearningProposal(),
      progressLog: [],
    });

    const orchestrator = new MessageOrchestrator(mockLLM(), data);
    const result = await orchestrator.process(makeInput('Yes'));

    // Should trigger the learning flow with the capability as search query
    expect(mockedExecute).toHaveBeenCalledOnce();
    expect(mockedExecute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serviceName: 'Tell Time API',
      }),
    );
    expect(result.sideEffects.find((e) => e.type === 'learning_proposal')).toBeDefined();
  });

  it('follow-up "no" after clarification falls through normally', async () => {
    const data = mockDataLoader();
    (data.loadConversationHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        messageId: 'msg-prev' as MessageId,
        sessionId: 'sess-1' as SessionId,
        botId: 'bot-1' as BotId,
        role: 'assistant',
        content: '<!-- learning-clarification:Tell Time -->I can do that! Want me to search?',
        attachments: [],
        skillId: null,
        timestamp: new Date(),
      },
    ]);

    const llm = mockLLM();
    const orchestrator = new MessageOrchestrator(llm, data);
    const result = await orchestrator.process(makeInput('No thanks'));

    // Should NOT trigger learning flow
    expect(mockedExecute).not.toHaveBeenCalled();
    // Should fall through to general conversation
    expect(llm.complete).toHaveBeenCalled();
    expect(result.response.content).toBe('General response.');
  });
});
