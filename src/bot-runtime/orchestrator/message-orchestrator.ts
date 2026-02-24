import type {
  OrchestratorInput,
  OrchestratorOutput,
  SideEffect,
  MemoryFact,
  SkillDataSnapshot,
  ProcessedResponse,
  ContextRequirements,
  LLMResponse,
  Prompt,
  SkillMatch,
  SkillProposal,
  TableSchema,
  RAGChunk,
} from '../../common/types/orchestrator.js';
import type { Message } from '../../common/types/message.js';
import type { BotConfig } from '../../common/types/bot.js';
import type { SkillDefinition } from '../../common/types/skill.js';
import type { ToolRegistryEntry, HttpToolResponse } from '../../common/types/tool-registry.js';
import type { BotId } from '../../common/types/ids.js';
import type { LearningProposal } from '../../web-research/types.js';
import { matchSkill } from '../skill-matcher/skill-matcher.js';
import { composeSkillPrompt, composeGeneralPrompt } from '../prompt-composer/prompt-composer.js';
import { decryptCredential } from '../../tool-execution/credential-vault.js';
import { executeHttpTool } from '../../tool-execution/http-executor.js';
import { processResponse } from '../response-processor/response-processor.js';
import { extractMemoryFacts } from '../memory-extractor/memory-extractor.js';
import { evaluateForProposal } from '../skill-proposer/skill-proposer.js';
import { detectLearningIntent, looksLikeServiceName } from '../../web-research/learning-detector.js';
import { executeLearningFlow } from '../../web-research/learning-flow.js';
import { WebResearchError } from '../../common/errors/index.js';

/**
 * LLM Gateway interface — the Orchestrator depends on this abstraction,
 * not on a concrete provider. This is what makes swapping providers easy.
 */
export interface LLMGatewayPort {
  complete(prompt: Prompt, options: { taskType: string; streaming: boolean }): Promise<LLMResponse>;
}

/**
 * Data loading interface — the Orchestrator calls this to load context.
 * Injected so the Orchestrator stays testable without real databases.
 */
export interface DataLoaderPort {
  loadBotConfig(botId: string): Promise<BotConfig>;
  loadSkills(botId: string): Promise<SkillDefinition[]>;
  loadConversationHistory(botId: string, sessionId: string, depth: number): Promise<Message[]>;
  loadMemoryFacts(botId: string, query: string | null): Promise<MemoryFact[]>;
  loadRAGResults(botId: string, query: string | null): Promise<RAGChunk[]>;
  loadSkillData(botId: string, tableName: string, query: string | null): Promise<SkillDataSnapshot>;
  loadTableSchemas(botId: string, tableNames: string[]): Promise<TableSchema[]>;
  loadRecentDismissals(botId: string): Promise<{ proposedName: string; dismissedAt: Date }[]>;
  loadTools(botId: string, names: string[]): Promise<ToolRegistryEntry[]>;
}

/**
 * MessageOrchestrator — Spec #2 core implementation.
 *
 * The thin coordination layer. Calls services in sequence:
 * 1. Load bot config + skills (from cache — Spec #4)
 * 2. Match skill (SkillMatcher — fast path then slow path)
 * 3. If matched: load selective context → compose prompt → call LLM → process response
 * 4. If not matched: evaluate for skill proposal → or general conversation
 * 5. Extract memory facts (async side effect)
 * 6. Return response + side effects
 *
 * The Orchestrator contains NO business logic. It's pure wiring.
 * Every piece of logic lives in the components it calls.
 */
export class MessageOrchestrator {
  constructor(
    private readonly llm: LLMGatewayPort,
    private readonly data: DataLoaderPort,
  ) {}

  async process(input: OrchestratorInput): Promise<OrchestratorOutput> {
    const { message, botId, sessionId } = input;
    const sideEffects: SideEffect[] = [];

    // 1. Load bot config and skills (cache-first — Spec #4)
    const [botConfig, skills] = await Promise.all([
      this.data.loadBotConfig(botId as string),
      this.data.loadSkills(botId as string),
    ]);

    // 2. Check for learning intent (fast regex — <1ms, runs before skill matching)
    const learningIntent = detectLearningIntent(message.content);
    if (learningIntent && learningIntent.confidence >= 0.7) {
      // High confidence → full learning flow
      const learningResult = await this.handleLearningFlow(
        message,
        botId as string,
        learningIntent.serviceName,
        sideEffects,
      );

      // Memory extraction still runs for learning messages
      const memoryFacts = extractMemoryFacts(message.content);
      if (memoryFacts.length > 0) {
        sideEffects.push({ type: 'memory_write', facts: memoryFacts });
      }

      return { response: learningResult, sideEffects };
    } else if (learningIntent && learningIntent.confidence >= 0.5) {
      // Medium confidence → clarification (ask the user to confirm intent)
      const clarification = buildLearningClarification(learningIntent.serviceName);

      const memoryFacts = extractMemoryFacts(message.content);
      if (memoryFacts.length > 0) {
        sideEffects.push({ type: 'memory_write', facts: memoryFacts });
      }

      return { response: clarification, sideEffects };
    }

    // 3. Match skill
    const skillMatch = await matchSkill(message, skills);

    let response: ProcessedResponse;

    if (skillMatch) {
      // 3a. Skill matched — selective context loading + LLM call
      response = await this.handleSkillMatch(
        skillMatch,
        message,
        botId as string,
        sessionId as string,
        botConfig,
        sideEffects,
      );
    } else {
      // 3b. No skill matched — check for proposal, or general conversation
      response = await this.handleNoMatch(
        message,
        botId as string,
        sessionId as string,
        botConfig,
        skills,
        sideEffects,
      );
    }

    // 4. Extract memory facts (side effect — processed async)
    const memoryFacts = extractMemoryFacts(message.content);
    if (memoryFacts.length > 0) {
      sideEffects.push({ type: 'memory_write', facts: memoryFacts });
    }

    return { response, sideEffects };
  }

  private async handleSkillMatch(
    match: SkillMatch,
    message: OrchestratorInput['message'],
    botId: string,
    sessionId: string,
    botConfig: BotConfig,
    sideEffects: SideEffect[],
  ): Promise<ProcessedResponse> {
    const { skill, contextRequirements, modelPreferences } = match;

    // Load tools if skill requires external integrations
    let apiTools: ToolRegistryEntry[] = [];
    if (skill.requiredIntegrations.length > 0) {
      apiTools = await this.data.loadTools(botId, skill.requiredIntegrations);
    }

    // Selective context loading (Spec #4 Phase 2)
    const context = await this.loadSelectiveContext(
      botId,
      sessionId,
      skill,
      contextRequirements,
    );

    // Compose prompt (pure function — no I/O)
    const prompt = composeSkillPrompt({
      skill,
      message,
      conversationHistory: context.history,
      memoryContext: context.memory,
      ragResults: context.rag,
      skillData: context.skillData,
      tableSchemas: context.tableSchemas,
      soul: botConfig.soul,
      apiTools: apiTools.length > 0 ? apiTools : undefined,
    });

    // Call LLM
    let llmResponse = await this.llm.complete(prompt, {
      taskType: modelPreferences.taskType,
      streaming: modelPreferences.streaming,
    });

    // Process tool calls from LLM response as side effects
    for (const toolCall of llmResponse.toolCalls) {
      if (toolCall.toolName === 'call_api') {
        // Handle external API call
        const apiResult = await this.handleApiCall(toolCall.arguments, apiTools, sideEffects);

        // Multi-turn: feed API response back to LLM for a final user-facing answer
        if (apiResult !== null) {
          const followUpPrompt: Prompt = {
            ...prompt,
            messages: [
              ...prompt.messages,
              { role: 'assistant', content: `[API Result]: ${JSON.stringify(apiResult.body)}` },
              { role: 'user', content: 'Based on the API result above, provide the final answer to the user.' },
            ],
          };
          llmResponse = await this.llm.complete(followUpPrompt, {
            taskType: modelPreferences.taskType,
            streaming: modelPreferences.streaming,
          });
        }
      } else if (toolCall.toolName === 'insert_skill_data' && skill.dataTable) {
        sideEffects.push({
          type: 'skill_data_write',
          table: skill.dataTable,
          operation: 'insert',
          data: toolCall.arguments.data as Record<string, unknown>,
        });
      } else if (toolCall.toolName === 'update_skill_data' && skill.dataTable) {
        sideEffects.push({
          type: 'skill_data_write',
          table: skill.dataTable,
          operation: 'update',
          data: toolCall.arguments as Record<string, unknown>,
        });
      } else if (toolCall.toolName === 'schedule_notification') {
        sideEffects.push({
          type: 'schedule_notification',
          message: toolCall.arguments.message as string,
          at: new Date(toolCall.arguments.at as string),
          recurring: (toolCall.arguments.recurring as string) ?? null,
        });
      }
    }

    // Post-process
    return processResponse(llmResponse, skill);
  }

  /**
   * Execute an external API call via the registered tool system.
   * Decrypts credentials, validates endpoint, calls http-executor.
   */
  private async handleApiCall(
    args: Record<string, unknown>,
    tools: ToolRegistryEntry[],
    sideEffects: SideEffect[],
  ): Promise<HttpToolResponse | null> {
    const toolName = args.tool as string;
    const endpointPath = args.endpoint as string;
    const method = args.method as string;
    const body = args.body ?? null;

    // Find the registered tool
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) return null;

    // Validate endpoint is registered
    const endpoint = tool.endpoints.find((e) => e.path === endpointPath && e.method === method);
    if (!endpoint) return null;

    const startMs = Date.now();

    try {
      // Decrypt credentials (never appears in prompts or logs)
      const plaintext = decryptCredential(tool.authConfig.encrypted);
      const authData = JSON.parse(plaintext) as Record<string, string>;

      // Build auth headers based on auth type
      const headers: Record<string, string> = {};
      switch (tool.authType) {
        case 'api_key':
          headers[authData.headerName ?? 'X-Api-Key'] = authData.key;
          break;
        case 'bearer':
          headers['Authorization'] = `Bearer ${authData.token}`;
          break;
        case 'custom_header':
          headers[authData.headerName] = authData.headerValue;
          break;
        case 'oauth2':
          headers['Authorization'] = `Bearer ${authData.accessToken}`;
          break;
      }

      // Execute the HTTP call
      const response = await executeHttpTool({
        url: tool.baseUrl + endpointPath,
        method: endpoint.method,
        headers,
        body,
        timeoutMs: 10_000,
      });

      sideEffects.push({
        type: 'api_call',
        toolName,
        endpoint: endpointPath,
        status: response.status,
        latencyMs: Date.now() - startMs,
      });

      return response;
    } catch {
      sideEffects.push({
        type: 'api_call',
        toolName,
        endpoint: endpointPath,
        status: 0,
        latencyMs: Date.now() - startMs,
      });
      return null;
    }
  }

  private async handleNoMatch(
    message: OrchestratorInput['message'],
    botId: string,
    sessionId: string,
    botConfig: BotConfig,
    skills: SkillDefinition[],
    sideEffects: SideEffect[],
  ): Promise<ProcessedResponse> {
    // Check if we should propose a new skill
    const dismissals = await this.data.loadRecentDismissals(botId);
    const proposal = evaluateForProposal(message, skills, { recentDismissals: dismissals });

    if (proposal) {
      sideEffects.push({ type: 'skill_proposal', proposal });
      return formatSkillProposal(proposal);
    }

    // General conversation — no skill, no proposal
    const history = await this.data.loadConversationHistory(botId, sessionId, 10);
    const memory = await this.data.loadMemoryFacts(botId, null);

    const prompt = composeGeneralPrompt({
      message,
      conversationHistory: history,
      memoryContext: memory,
      botConfig: {
        name: botConfig.name,
        personality: botConfig.personality,
        context: botConfig.context,
        soul: botConfig.soul,
      },
      skillSummary: skills.length > 0
        ? skills.map((s) => ({ name: s.name, description: s.description }))
        : undefined,
    });

    const llmResponse = await this.llm.complete(prompt, {
      taskType: 'simple_qa',
      streaming: true,
    });

    return processResponse(llmResponse, null);
  }

  /**
   * Handle a learning intent — run the web research pipeline
   * and return a formatted proposal to the user.
   */
  private async handleLearningFlow(
    message: OrchestratorInput['message'],
    botId: string,
    serviceName: string,
    sideEffects: SideEffect[],
  ): Promise<ProcessedResponse> {
    try {
      const result = await executeLearningFlow(this.llm, {
        botId: botId as BotId,
        userMessage: message.content,
        serviceName,
      });

      sideEffects.push({
        type: 'learning_proposal',
        proposal: {
          serviceName: result.proposal.serviceName,
          endpointCount: result.proposal.toolProposal.endpoints.length,
          skillCount: result.proposal.skillProposals.length,
          sourceUrls: result.proposal.sourceUrls,
        },
      });

      return formatLearningProposal(result.proposal);
    } catch (err) {
      if (err instanceof WebResearchError) {
        return {
          content: `I tried to learn about ${serviceName} but ran into an issue: ${err.message}`,
          format: 'text',
          structuredData: null,
          skillId: null,
          suggestedActions: ['Try again', 'Never mind'],
        };
      }
      throw err;
    }
  }

  /**
   * Load only the context the matched skill needs (Spec #4 Phase 2).
   * Runs fetches in parallel for minimum latency.
   */
  private async loadSelectiveContext(
    botId: string,
    sessionId: string,
    skill: SkillDefinition,
    reqs: ContextRequirements,
  ): Promise<{
    history: Message[];
    memory: MemoryFact[];
    rag: RAGChunk[];
    skillData: SkillDataSnapshot;
    tableSchemas: TableSchema[];
  }> {
    const fetches: Promise<unknown>[] = [];
    const indices: string[] = [];

    // Conversation history
    if (reqs.needsConversationHistory && reqs.historyDepth > 0) {
      fetches.push(this.data.loadConversationHistory(botId, sessionId, reqs.historyDepth));
      indices.push('history');
    }

    // Memory
    if (reqs.needsMemory) {
      fetches.push(this.data.loadMemoryFacts(botId, reqs.memoryQuery));
      indices.push('memory');
    }

    // RAG
    if (reqs.needsRAG) {
      fetches.push(this.data.loadRAGResults(botId, reqs.ragQuery));
      indices.push('rag');
    }

    // Skill data
    if (reqs.needsSkillData && skill.dataTable) {
      fetches.push(this.data.loadSkillData(botId, skill.dataTable, reqs.skillDataQuery));
      indices.push('skillData');
    }

    // Table schemas (always load if skill has data tables — needed for tool definitions)
    const allTables = skill.dataTable ? [skill.dataTable, ...skill.readableTables] : skill.readableTables;
    if (allTables.length > 0) {
      fetches.push(this.data.loadTableSchemas(botId, allTables));
      indices.push('tableSchemas');
    }

    // Run all fetches in parallel
    const results = await Promise.all(fetches);

    // Map results back to named fields
    const resultMap: Record<string, unknown> = {};
    for (let i = 0; i < indices.length; i++) {
      resultMap[indices[i]] = results[i];
    }

    return {
      history: (resultMap.history as Message[]) ?? [],
      memory: (resultMap.memory as MemoryFact[]) ?? [],
      rag: (resultMap.rag as RAGChunk[]) ?? [],
      skillData: (resultMap.skillData as SkillDataSnapshot) ?? { tableName: '', rows: [], totalCount: 0 },
      tableSchemas: (resultMap.tableSchemas as TableSchema[]) ?? [],
    };
  }
}

function formatSkillProposal(proposal: SkillProposal): ProcessedResponse {
  const lines: string[] = [];
  lines.push(`I don't have a way to do that yet, but I can learn!`);
  lines.push('');
  lines.push(`**${proposal.proposedName}**: ${proposal.description}`);
  lines.push('');

  if (proposal.triggerExamples.length > 0) {
    lines.push(`You could say things like:`);
    for (const ex of proposal.triggerExamples.slice(0, 3)) {
      lines.push(`- "${ex}"`);
    }
    lines.push('');
  }

  if (proposal.clarifyingQuestions.length > 0) {
    lines.push(proposal.clarifyingQuestions[0]);
  } else {
    lines.push('Want me to set this up?');
  }

  return {
    content: lines.join('\n'),
    format: 'text',
    structuredData: null,
    skillId: null,
    suggestedActions: ['Yes, create it', 'No thanks'],
  };
}

function formatLearningProposal(proposal: LearningProposal): ProcessedResponse {
  const lines: string[] = [];
  lines.push(`I've researched the **${proposal.serviceName}** API and here's what I found:`);
  lines.push('');
  lines.push(`**API**: ${proposal.toolProposal.baseUrl} (${proposal.toolProposal.authType} auth, ${proposal.toolProposal.endpoints.length} endpoints)`);
  lines.push('');

  if (proposal.skillProposals.length > 0) {
    lines.push('**Skills I can create**:');
    for (const skill of proposal.skillProposals) {
      lines.push(`- **${skill.name}**: ${skill.description}`);
    }
    lines.push('');
  }

  if (proposal.authInstructions) {
    lines.push(`**To get started**: ${proposal.authInstructions}`);
    lines.push('');
  }

  lines.push('Want me to set this up?');

  return {
    content: lines.join('\n'),
    format: 'text',
    structuredData: null,
    skillId: null,
    suggestedActions: ['Yes, set it up', 'No thanks'],
  };
}

/**
 * Build a clarification response for medium-confidence learning intents.
 * If the name looks like a service → ask if they want to research it.
 * If the name looks like a capability → ask which API/service to look into.
 */
function buildLearningClarification(serviceName: string): ProcessedResponse {
  if (looksLikeServiceName(serviceName)) {
    return {
      content: `I can learn how to use **${serviceName}**! Want me to research its API docs and set up an integration?`,
      format: 'text',
      structuredData: null,
      skillId: null,
      suggestedActions: [`Yes, learn ${serviceName}`, 'No thanks'],
    };
  }

  return {
    content: `I can learn that! Which API or service should I look into? For example, if you want me to ${serviceName.toLowerCase()}, I could look into a relevant API.`,
    format: 'text',
    structuredData: null,
    skillId: null,
    suggestedActions: ['Tell me more', 'Never mind'],
  };
}
