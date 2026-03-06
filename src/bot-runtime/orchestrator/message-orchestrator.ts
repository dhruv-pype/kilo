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
  StoredProposal,
  StoredRefinement,
  SkillRefinementResult,
  SkillGenerationResult,
  TableSchema,
  RAGChunk,
  FieldSuggestion,
} from '../../common/types/orchestrator.js';
import type { Message } from '../../common/types/message.js';
import type { BotConfig } from '../../common/types/bot.js';
import type { SkillDefinition, SkillCreateInput } from '../../common/types/skill.js';
import type { ToolRegistryEntry, HttpToolResponse } from '../../common/types/tool-registry.js';
import type { BotId } from '../../common/types/ids.js';
import { v4 as uuidv4 } from 'uuid';
import type { LearningProposal } from '../../web-research/types.js';
import { matchSkill } from '../skill-matcher/skill-matcher.js';
import { composeSkillPrompt, composeGeneralPrompt } from '../prompt-composer/prompt-composer.js';
import { decryptCredential } from '../../tool-execution/credential-vault.js';
import { executeHttpTool } from '../../tool-execution/http-executor.js';
import { processResponse } from '../response-processor/response-processor.js';
import { extractMemoryFacts, regexExtractMemoryFacts } from '../memory-extractor/memory-extractor.js';
import { evaluateForProposal } from '../skill-proposer/skill-proposer.js';
import {
  detectLearningIntent,
  looksLikeServiceName,
  detectClarificationFollowUp,
  buildClarificationMarker,
  detectProposalFollowUp,
  buildProposalMarker,
  detectRefinementFollowUp,
  detectPostExecutionFeedback,
  detectSkillRefinementIntent,
  buildRefinementMarker,
} from '../../web-research/learning-detector.js';
import { generate as skillGenerate, refine as skillRefine } from '../../skill-engine/skill-generator.js';
import { executeLearningFlow } from '../../web-research/learning-flow.js';
import { WebResearchError } from '../../common/errors/index.js';
import {
  getBuiltInSkills,
  isBuiltInSkill,
  getBuiltInHandler,
} from '../../skill-engine/builtin-skills/index.js';

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
  querySkillData(schemaName: string, sql: string): Promise<Record<string, unknown>[]>;
  loadProposal(proposalId: string): Promise<StoredProposal | null>;
  createSkill(botId: string, input: SkillCreateInput): Promise<void>;
  acceptProposal(proposalId: string): Promise<void>;
  dismissProposal(proposalId: string): Promise<void>;
  updateSkill(skillId: string, updates: Partial<{
    behaviorPrompt: string;
    triggerPatterns: string[];
    description: string;
    needsHistory: boolean;
    needsMemory: boolean;
    readsData: boolean;
  }>): Promise<void>;
  saveRefinement(skillId: string, botId: string, result: SkillRefinementResult): Promise<string>;
  loadRefinement(refinementId: string): Promise<StoredRefinement | null>;
  applyRefinement(refinementId: string): Promise<void>;
  dismissRefinement(refinementId: string): Promise<void>;
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
    const [botConfig, dbSkills] = await Promise.all([
      this.data.loadBotConfig(botId as string),
      this.data.loadSkills(botId as string),
    ]);

    // Merge built-in skills (prepend so they match first for common queries)
    const skills = [...getBuiltInSkills(), ...dbSkills];

    // 2a. Check if user is responding to a previous learning clarification
    const history = await this.data.loadConversationHistory(botId as string, sessionId as string, 2);
    const lastBotMsg = history.filter((m) => m.role === 'assistant').at(-1);
    const followUp = detectClarificationFollowUp(message.content, lastBotMsg?.content ?? null);
    if (followUp) {
      // User confirmed a clarification — trigger learning with the search query
      const learningResult = await this.handleLearningFlow(
        message,
        botId as string,
        followUp.searchQuery,
        sideEffects,
      );

      // Memory extraction (async, non-blocking)
      await this.extractAndPushMemory(message.content, learningResult.content, botId as string, sideEffects);

      return { response: learningResult, sideEffects };
    }

    // 2b-proposal. Check if user is responding to a previous skill proposal
    const proposalFollowUp = detectProposalFollowUp(message.content, lastBotMsg?.content ?? null);
    if (proposalFollowUp) {
      let response: ProcessedResponse;
      if (proposalFollowUp.accepted) {
        response = await this.handleSkillCreation(proposalFollowUp.proposalId, botId as string, sideEffects);
      } else {
        response = await this.handleProposalDismissal(proposalFollowUp.proposalId);
      }
      await this.extractAndPushMemory(message.content, response.content, botId as string, sideEffects);
      return { response, sideEffects };
    }

    // 2b-refine-followup. Check if user is responding to a skill refinement preview
    const refinementFollowUp = detectRefinementFollowUp(message.content, lastBotMsg?.content ?? null);
    if (refinementFollowUp) {
      let response: ProcessedResponse;
      if (refinementFollowUp.accepted) {
        response = await this.handleApplyRefinement(refinementFollowUp.refinementId);
      } else {
        response = await this.handleRefinementDismissal(refinementFollowUp.refinementId);
      }
      await this.extractAndPushMemory(message.content, response.content, botId as string, sideEffects);
      return { response, sideEffects };
    }

    // 2c. Check for learning intent (fast regex — <1ms, runs before skill matching)
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
      await this.extractAndPushMemory(message.content, learningResult.content, botId as string, sideEffects);

      return { response: learningResult, sideEffects };
    } else if (learningIntent && learningIntent.confidence >= 0.5) {
      // Medium confidence → clarification (ask the user to confirm intent)
      const clarification = buildLearningClarification(learningIntent.serviceName);

      await this.extractAndPushMemory(message.content, clarification.content, botId as string, sideEffects);

      return { response: clarification, sideEffects };
    }

    // 2d. Check for explicit skill refinement requests ("fix my steps skill")
    const refinementIntent = detectSkillRefinementIntent(message.content, dbSkills);
    if (refinementIntent) {
      const recentMessages = await this.data.loadConversationHistory(botId as string, sessionId as string, 5);
      const response = await this.handleSkillRefinement(
        refinementIntent.skill,
        refinementIntent.feedback,
        recentMessages,
        botId as string,
        sideEffects,
      );
      await this.extractAndPushMemory(message.content, response.content, botId as string, sideEffects);
      return { response, sideEffects };
    }

    // 2e. Check for post-execution negative feedback ("that's wrong")
    const postExecFeedback = detectPostExecutionFeedback(message.content, lastBotMsg?.content ?? null);
    if (postExecFeedback) {
      const skillForFeedback = dbSkills.find((s) => s.skillId === postExecFeedback.skillId);
      if (skillForFeedback) {
        const recentMessages = await this.data.loadConversationHistory(botId as string, sessionId as string, 5);
        const response = await this.handleSkillRefinement(
          skillForFeedback,
          message.content,
          recentMessages,
          botId as string,
          sideEffects,
        );
        await this.extractAndPushMemory(message.content, response.content, botId as string, sideEffects);
        return { response, sideEffects };
      }
    }

    // 3. Match skill (LLM-powered slow path when fast match is uncertain)
    const skillMatch = await matchSkill(message, skills, this.llm);

    let response: ProcessedResponse;

    if (skillMatch && isBuiltInSkill(skillMatch.skill)) {
      // 3a. Built-in skill matched — direct execution, no LLM call
      const handler = getBuiltInHandler(skillMatch.skill.skillId as string);
      response = handler!(message.content);
    } else if (skillMatch) {
      // 3b. User skill matched — selective context loading + LLM call
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

    // 4. Extract memory facts + soul updates (side effects — processed async)
    // Skip extraction if neither the message nor the response contains
    // any signals that personal facts might be present. Saves an LLM call
    // on pure command messages ("log a sale", "what time is it", etc).
    if (mightContainPersonalFacts(message.content, response.content)) {
      await this.extractAndPushMemory(message.content, response.content, botId as string, sideEffects);
    }
    await this.extractAndPushSoulUpdates(message.content, response.content, botId as string, botConfig, sideEffects);

    return { response, sideEffects };
  }

  /**
   * LLM-powered memory extraction helper.
   * Loads existing facts so the LLM can avoid duplicates, then pushes new facts as a side effect.
   * Never blocks the response — catches and logs all errors.
   */
  private async extractAndPushMemory(
    userContent: string,
    assistantContent: string,
    botId: string,
    sideEffects: SideEffect[],
  ): Promise<void> {
    try {
      const existingFacts = await this.data.loadMemoryFacts(botId, null);
      const newFacts = await extractMemoryFacts(userContent, assistantContent, existingFacts, this.llm);
      if (newFacts.length > 0) {
        sideEffects.push({ type: 'memory_write', facts: newFacts });
      }
    } catch (err) {
      console.warn('[orchestrator] Memory extraction failed:', (err as Error).message);
    }
  }

  /**
   * LLM-powered soul evolution helper.
   * Detects explicit personality instructions and pushes patches as a side effect.
   * Only runs when the bot has a soul defined. Never blocks the response.
   */
  private async extractAndPushSoulUpdates(
    userContent: string,
    assistantContent: string,
    botId: string,
    botConfig: BotConfig,
    sideEffects: SideEffect[],
  ): Promise<void> {
    if (!botConfig.soul) return;
    try {
      // Dynamic import to avoid circular dependency issues at module load time
      const { extractSoulUpdates } = await import('../soul-evolver/soul-evolver.js');
      const patches = await extractSoulUpdates(userContent, assistantContent, botConfig.soul, this.llm);
      if (patches.length > 0) {
        sideEffects.push({ type: 'soul_update', patches, botId });
      }
    } catch (err) {
      console.warn('[orchestrator] Soul extraction failed:', (err as Error).message);
    }
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
      if (toolCall.toolName === 'query_skill_data') {
        // Execute the SELECT query and feed results back for a final answer
        try {
          const rows = await this.data.querySkillData(
            botConfig.schemaName,
            toolCall.arguments.sql as string,
          );
          const followUpPrompt: Prompt = {
            ...prompt,
            messages: [
              ...prompt.messages,
              { role: 'assistant', content: `[Query Result]: ${JSON.stringify(rows)}` },
              { role: 'user', content: 'Based on the query results above, provide the final answer to the user.' },
            ],
          };
          llmResponse = await this.llm.complete(followUpPrompt, {
            taskType: modelPreferences.taskType,
            streaming: modelPreferences.streaming,
          });
        } catch (err) {
          console.warn('[orchestrator] query_skill_data failed:', (err as Error).message);
        }
      } else if (toolCall.toolName === 'call_api') {
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
    const proposal = await evaluateForProposal(message, skills, { recentDismissals: dismissals }, this.llm);

    if (proposal) {
      const proposalId = uuidv4();
      sideEffects.push({ type: 'skill_proposal', proposalId, proposal });
      const formatted = formatSkillProposal(proposal);
      return { ...formatted, content: buildProposalMarker(proposalId) + '\n' + formatted.content };
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

  /**
   * Handle "Yes, create it" — load the stored proposal, create the skill, mark accepted.
   */
  private async handleSkillCreation(
    proposalId: string,
    botId: string,
    _sideEffects: SideEffect[],
  ): Promise<ProcessedResponse> {
    const stored = await this.data.loadProposal(proposalId);
    if (!stored) {
      return {
        content: "I'm sorry, I couldn't find that proposal. It may have expired.",
        format: 'text',
        structuredData: null,
        skillId: null,
        suggestedActions: [],
      };
    }

    let input = proposalToSkillInput(botId, stored.proposal);

    // Generate domain-specific behavior prompt via LLM
    try {
      const tableSchema = proposalToDDL(stored.proposal);
      const generated = await skillGenerate(stored.proposal, tableSchema, this.llm);
      input = mergeGenerated(input, generated);
    } catch (err) {
      console.warn('[orchestrator] SkillGenerator.generate failed, using template fallback:', (err as Error).message);
    }

    try {
      await this.data.createSkill(botId, input);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return {
        content: `I wasn't able to create that skill: ${detail}`,
        format: 'text',
        structuredData: null,
        skillId: null,
        suggestedActions: [],
      };
    }
    await this.data.acceptProposal(proposalId);

    const examples = stored.proposal.triggerExamples.slice(0, 3);
    const exampleList = examples.map((e) => `'${e}'`).join(', ');

    return {
      content: `Done! I've created the **${stored.proposal.proposedName}** skill. Try saying: ${exampleList}.`,
      format: 'text',
      structuredData: null,
      skillId: null,
      suggestedActions: examples,
    };
  }

  /**
   * Handle a skill refinement request — generate an improved spec and show a preview.
   */
  private async handleSkillRefinement(
    skill: SkillDefinition,
    feedback: string,
    recentMessages: import('../../common/types/message.js').Message[],
    botId: string,
    sideEffects: SideEffect[],
  ): Promise<ProcessedResponse> {
    const context = recentMessages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    let result: SkillRefinementResult;
    try {
      result = await skillRefine(skill, feedback, context, this.llm);
    } catch (err) {
      return {
        content: `I wasn't able to generate a refinement: ${(err as Error).message}`,
        format: 'text',
        structuredData: null,
        skillId: null,
        suggestedActions: [],
      };
    }

    const refinementId = uuidv4();
    sideEffects.push({
      type: 'skill_refinement',
      refinementId,
      skillId: skill.skillId as string,
      botId,
      result,
    });

    const preview = formatRefinementPreview(skill.name, result);
    return {
      content: buildRefinementMarker(refinementId) + '\n' + preview,
      format: 'text',
      structuredData: null,
      skillId: null,
      suggestedActions: ['Yes, apply it', 'No thanks'],
    };
  }

  /**
   * Handle "Yes, apply it" — apply the stored refinement to the skill.
   */
  private async handleApplyRefinement(refinementId: string): Promise<ProcessedResponse> {
    const stored = await this.data.loadRefinement(refinementId);
    if (!stored) {
      return {
        content: "I'm sorry, I couldn't find that refinement. It may have expired.",
        format: 'text',
        structuredData: null,
        skillId: null,
        suggestedActions: [],
      };
    }

    try {
      await this.data.updateSkill(stored.skillId, {
        behaviorPrompt: stored.result.behaviorPrompt,
        triggerPatterns: stored.result.triggerPatterns,
        description: stored.result.description,
        needsHistory: stored.result.needsHistory,
        needsMemory: stored.result.needsMemory,
        readsData: stored.result.readsData,
      });
      await this.data.applyRefinement(refinementId);
    } catch (err) {
      return {
        content: `I wasn't able to apply that refinement: ${(err as Error).message}`,
        format: 'text',
        structuredData: null,
        skillId: null,
        suggestedActions: [],
      };
    }

    return {
      content: `Done — the skill has been updated.`,
      format: 'text',
      structuredData: null,
      skillId: null,
      suggestedActions: [],
    };
  }

  /**
   * Handle "No thanks" on a refinement preview — dismiss it.
   */
  private async handleRefinementDismissal(refinementId: string): Promise<ProcessedResponse> {
    await this.data.dismissRefinement(refinementId);
    return {
      content: "No problem, I'll leave it as is.",
      format: 'text',
      structuredData: null,
      skillId: null,
      suggestedActions: [],
    };
  }

  /**
   * Handle "No thanks" — mark the proposal dismissed (enforces 7-day cooldown).
   */
  private async handleProposalDismissal(proposalId: string): Promise<ProcessedResponse> {
    await this.data.dismissProposal(proposalId);
    return {
      content: "No problem! Let me know if you change your mind.",
      format: 'text',
      structuredData: null,
      skillId: null,
      suggestedActions: [],
    };
  }
}

function proposalToSkillInput(botId: string, proposal: SkillProposal): SkillCreateInput {
  const hasFields = proposal.suggestedInputFields.length > 0;
  return {
    botId: botId as BotId,
    name: proposal.proposedName,
    description: proposal.description,
    triggerPatterns: proposal.triggerExamples,
    // Fallback prompt — SkillGenerator will override this when generation succeeds
    behaviorPrompt: buildBehaviorPrompt(proposal),
    inputSchema: hasFields ? fieldsToJsonSchema(proposal.suggestedInputFields) : null,
    outputFormat: 'text',
    schedule: proposal.suggestedSchedule,
    needsHistory: true,
    needsMemory: false,
    readsData: hasFields,
    readableTables: [],
    requiredIntegrations: [],
    createdBy: 'auto_proposed',
  };
}

/** Override template fields with LLM-generated equivalents. */
function mergeGenerated(base: SkillCreateInput, generated: SkillGenerationResult): SkillCreateInput {
  return {
    ...base,
    behaviorPrompt: generated.behaviorPrompt || base.behaviorPrompt,
    triggerPatterns: generated.triggerPatterns.length > 0 ? generated.triggerPatterns : base.triggerPatterns,
    description: generated.description || base.description,
    needsHistory: generated.needsHistory,
    needsMemory: generated.needsMemory,
    readsData: generated.readsData,
  };
}

/**
 * Build a simplified DDL preview from a proposal's input fields.
 * Passed to the skill generator so it can reference real column names.
 */
function proposalToDDL(proposal: SkillProposal): string | null {
  if (proposal.suggestedInputFields.length === 0) return null;
  const tableName = proposal.proposedName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
  const cols = [
    '  id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
    '  logged_at TIMESTAMPTZ NOT NULL DEFAULT now()',
  ];
  for (const f of proposal.suggestedInputFields) {
    const pgType =
      f.type === 'number' ? 'DOUBLE PRECISION'
      : f.type === 'integer' ? 'INTEGER'
      : f.type === 'boolean' ? 'BOOLEAN'
      : 'TEXT';
    const nullClause = f.required ? 'NOT NULL' : '';
    cols.push(`  ${f.name} ${pgType} ${nullClause}`.trim());
  }
  cols.push('  created_at TIMESTAMPTZ NOT NULL DEFAULT now()');
  return `CREATE TABLE ${tableName} (\n${cols.join(',\n')}\n);`;
}

/**
 * Format a refinement result as a user-visible preview.
 */
function formatRefinementPreview(skillName: string, result: SkillRefinementResult): string {
  const lines = [
    `I've generated an improved version of **${skillName}**. Here's what would change:`,
    '',
    result.changesSummary || '(no summary provided)',
    '',
    'Want me to apply these changes?',
  ];
  return lines.join('\n');
}

function buildBehaviorPrompt(proposal: SkillProposal): string {
  const { description, suggestedInputFields, dataModel } = proposal;

  if (suggestedInputFields.length === 0) {
    return `## What this skill does\n${description}\n\nBe helpful and concise. Never expose internal details to the user.`;
  }

  const requiredFields = suggestedInputFields.filter((f) => f.required).map((f) => f.name);
  const fieldList = suggestedInputFields
    .map((f) => `- **${f.name}** (${f.type}${f.required ? ', required' : ', optional'}): ${f.description}`)
    .join('\n');

  const dataModelLabel =
    dataModel === 'daily_total' ? 'daily total (one entry per day, updated in-place)'
    : dataModel === 'singleton' ? 'singleton (one row, always overwritten)'
    : 'per event (new row for every logged event)';

  const insertOrUpdateSection =
    dataModel === 'daily_total'
      ? `## Logging or updating
1. Extract fields from the user's message. Required: ${requiredFields.join(', ') || 'none'}.
2. If logged_at is not mentioned, omit it — the database defaults to now.
3. Call query_skill_data to check whether an entry already exists for today:
   SELECT * FROM {table} WHERE logged_at::date = CURRENT_DATE ORDER BY logged_at DESC LIMIT 1
4. If a row exists: add the new value to the existing total and call update_skill_data.
5. If no row exists: call insert_skill_data.
6. Confirm concisely: "Logged X. Today's total: Y." Do not repeat all fields back.`
    : dataModel === 'singleton'
      ? `## Updating the current state
1. Extract fields from the user's message. Required: ${requiredFields.join(', ') || 'none'}.
2. Call query_skill_data to check whether a row already exists: SELECT COUNT(*) FROM {table}
3. If a row exists: call update_skill_data to overwrite it.
4. If no row exists: call insert_skill_data.
5. Confirm concisely what was set.`
      : `## Logging a new entry
1. Extract fields from the user's message. Required: ${requiredFields.join(', ') || 'none'}.
2. If logged_at is not mentioned, omit it — the database defaults to now.
3. Call insert_skill_data with the extracted data.
4. Confirm concisely: "Logged." Do not repeat all fields back.`;

  const addMoreSection =
    dataModel === 'daily_total'
      ? `## Handling "X more" or "another X"
Query today's entry first. Add X to the existing value. Call update_skill_data with the new total.`
      : `## Handling "X more" or "another X"
Treat as a new separate entry. Call insert_skill_data with the value X.`;

  return `## What this skill does
${description}

## Data model: ${dataModelLabel}

## Fields
${fieldList}
- **logged_at** (timestamp, optional): When this event occurred. Defaults to now if omitted. Understand natural language like "yesterday", "this morning", "last Tuesday" and convert to ISO 8601.

${insertOrUpdateSection}

${addMoreSection}

## Querying data
When the user asks to view, list, search, or summarize:
- Use query_skill_data with appropriate SQL.
- "today" → WHERE logged_at::date = CURRENT_DATE
- "this week" → WHERE logged_at >= date_trunc('week', now())
- "yesterday" → WHERE logged_at::date = CURRENT_DATE - 1
- "last 7 days" → WHERE logged_at >= now() - INTERVAL '7 days'
- Present results in a readable format. Never show raw SQL, table names, or column names.

## Edge cases
- Missing required fields: ask the user before calling insert_skill_data. Do not guess.
- Retroactive logging ("I walked 8k steps yesterday"): parse the time reference and pass it as logged_at.
- Ambiguous update targets: if multiple rows match and it's unclear which to update, ask the user.
- Never expose table names, schema names, or SQL syntax to the user.`;
}

function fieldsToJsonSchema(fields: FieldSuggestion[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of fields) {
    properties[f.name] = { type: f.type, description: f.description };
    if (f.required) required.push(f.name);
  }
  return { type: 'object', properties, required };
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
 * Embeds a hidden marker so follow-up detection can continue the flow.
 *
 * If the name looks like a service → ask if they want to research it.
 * If the name looks like a capability → offer to search for a relevant API.
 */
function buildLearningClarification(serviceName: string): ProcessedResponse {
  const marker = buildClarificationMarker(serviceName);

  if (looksLikeServiceName(serviceName)) {
    return {
      content: `${marker}I can learn how to use **${serviceName}**! Want me to search the web for its API docs and set up an integration?`,
      format: 'text',
      structuredData: null,
      skillId: null,
      suggestedActions: [`Yes, learn ${serviceName}`, 'No thanks'],
    };
  }

  return {
    content: `${marker}I can do that! I'll search the web for a free API that can **${serviceName.toLowerCase()}**. Want me to go ahead and look?`,
    format: 'text',
    structuredData: null,
    skillId: null,
    suggestedActions: ['Yes, search for it', 'No thanks'],
  };
}

/**
 * Quick check: does this conversation turn likely contain personal facts worth
 * persisting to memory? Avoids calling the memory extraction LLM on pure
 * command messages like "log a sale" or "what time is it".
 */
const PERSONAL_FACT_SIGNALS = [
  /\bmy name\b/i,
  /\bi'?m\b/i,
  /\bwe'?re\b/i,
  /\b(my|our) (business|company|shop|store|bakery|studio|firm|agency)\b/i,
  /\bi (prefer|like|always|usually|typically)\b/i,
  /\b(based|located) in\b/i,
  /\b\d+\s+(employees?|staff|people|team members?)\b/i,
  /\bmy (email|phone|address|website|contact)\b/i,
];

function mightContainPersonalFacts(userMessage: string, assistantResponse: string): boolean {
  const combined = userMessage + ' ' + assistantResponse;
  return PERSONAL_FACT_SIGNALS.some((p) => p.test(combined));
}
