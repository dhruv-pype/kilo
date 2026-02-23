# Spec #2: Explicit Orchestrator Pattern with Clean Interfaces

## Decision
Define a Message Orchestrator as the central coordination point in the Bot Runtime. Downstream responsibilities are split into four distinct interfaces: SkillMatcher, PromptComposer, LLMGateway, and SkillProposer. Each is independently testable and replaceable.

## Problem Being Solved
The PRD defines Bot Runtime, Skill Engine, and LLM Gateway as separate components but doesn't assign ownership of key responsibilities: intent classification, prompt composition, "no skill matched" logic, or cross-component data assembly. Without clear boundaries, these will merge into an untestable god service.

## Design

### 1. Component Ownership Map

Every responsibility in the message flow now has exactly one owner:

| Responsibility | Owner | Interface |
|---|---|---|
| Receive message, authenticate, route | API Gateway | (existing) |
| Orchestrate the message pipeline | MessageOrchestrator | `process(message) → Response` |
| Match user intent to a skill | SkillMatcher | `match(message, skills[]) → SkillMatch \| null` |
| Determine what context is needed | SkillMatcher | returns `ContextRequirements` on the match result |
| Compose the LLM prompt | PromptComposer | `compose(CompositionInput) → Prompt` |
| Call the LLM and get a response | LLMGateway | `complete(prompt, options) → LLMResponse` |
| Detect when a new skill should be proposed | SkillProposer | `evaluate(message, skills[], conversationHistory) → SkillProposal \| null` |
| Validate and create a new skill | SkillValidator | `validate(skillDraft) → ValidationResult` (see Spec #3) |
| Extract memory from conversation | MemoryExtractor | `extract(message, response) → MemoryFact[]` |
| Post-process LLM response (safety, formatting) | ResponseProcessor | `process(llmResponse, skill) → ProcessedResponse` |

### 2. Interface Definitions

#### MessageOrchestrator

The thin coordination layer. It calls services in sequence but contains no business logic itself.

```typescript
interface MessageOrchestrator {
  process(input: OrchestratorInput): Promise<OrchestratorOutput>;
}

interface OrchestratorInput {
  message: UserMessage;
  botId: string;
  sessionId: string;
}

interface OrchestratorOutput {
  response: ProcessedResponse;
  sideEffects: SideEffect[];  // memory writes, skill proposals, notifications scheduled
}
```

**The Orchestrator's flow** (pseudocode):
```
1. Load bot config + skills (from cache — see Spec #4)
2. skillMatch = SkillMatcher.match(message, skills)
3. IF skillMatch:
     contextReqs = skillMatch.contextRequirements
     context = loadContext(contextReqs)  // selective loading — Spec #4
     prompt = PromptComposer.compose({ skill, message, context })
     llmResponse = LLMGateway.complete(prompt, skillMatch.modelPreferences)
     response = ResponseProcessor.process(llmResponse, skill)
4. ELSE:
     proposal = SkillProposer.evaluate(message, skills, recentHistory)
     IF proposal:
       response = formatSkillProposal(proposal)
     ELSE:
       // General conversation — no skill needed
       prompt = PromptComposer.composeGeneral({ message, memory, recentHistory })
       llmResponse = LLMGateway.complete(prompt, { model: 'fast' })
       response = ResponseProcessor.process(llmResponse, null)
5. memoryFacts = MemoryExtractor.extract(message, response)
6. RETURN { response, sideEffects: [...memoryFacts, proposal] }
```

#### SkillMatcher

Determines which skill (if any) should handle a message.

```typescript
interface SkillMatcher {
  match(message: UserMessage, skills: SkillDefinition[]): Promise<SkillMatch | null>;
}

interface SkillMatch {
  skill: SkillDefinition;
  confidence: number;            // 0.0–1.0
  contextRequirements: ContextRequirements;
  modelPreferences: ModelPreferences;
}

interface ContextRequirements {
  needsConversationHistory: boolean;  // how many recent messages
  historyDepth: number;               // e.g., 5 for context, 50 for analysis
  needsMemory: boolean;               // load user memory/facts
  memoryQuery?: string;               // semantic query for relevant memories
  needsRAG: boolean;                  // search knowledge base
  ragQuery?: string;                  // what to search for
  needsSkillData: boolean;            // load data from skill's table
  skillDataQuery?: string;            // SQL-like hint for what data to fetch
}
```

**Implementation strategy**: Two-phase matching.
1. **Fast path (rule-based)**: Check `trigger_patterns` using keyword/regex matching. This handles "new order", "remind me", "what orders" — the common cases. ~1ms.
2. **Slow path (LLM-based)**: If no trigger pattern matches with high confidence, use a fast/cheap model (Haiku-class) to classify intent against skill descriptions. ~200ms. Only invoked when the fast path returns no match or low confidence.

The two-phase approach means most messages are routed in <5ms, and only ambiguous messages pay the LLM latency cost.

#### PromptComposer

Assembles the final LLM prompt from multiple data sources.

```typescript
interface PromptComposer {
  compose(input: CompositionInput): Prompt;
  composeGeneral(input: GeneralInput): Prompt;
}

interface CompositionInput {
  skill: SkillDefinition;
  message: UserMessage;
  conversationHistory: Message[];
  memoryContext: MemoryFact[];
  ragResults: RAGChunk[];
  skillData: SkillDataSnapshot;     // relevant rows from the skill's table
  tableSchemas: TableSchema[];       // schemas of readable tables (for SQL generation)
}

interface Prompt {
  system: string;     // system prompt with skill behavior, constraints, safety
  messages: Message[];  // conversation history formatted for the LLM
  tools?: ToolDefinition[];  // if the skill can take actions (query data, schedule, etc.)
}
```

**Key design choice**: The PromptComposer is a pure function — no I/O, no database calls. It takes already-loaded data and formats it. This makes it trivially testable: give it inputs, assert on outputs.

**Prompt structure** (for a skill-matched message):
```
SYSTEM:
  You are {bot_name}, a personal assistant for {user_context}.

  ACTIVE SKILL: {skill.name}
  SKILL INSTRUCTIONS: {skill.behavior_prompt}

  AVAILABLE DATA TABLES:
  {tableSchemas formatted as CREATE TABLE statements}

  USER MEMORY:
  {memoryContext formatted as bullet points}

  RELEVANT KNOWLEDGE:
  {ragResults formatted as excerpts}

  CONSTRAINTS:
  - {safety rules}
  - {output format requirements}

MESSAGES:
  {conversationHistory + current message}

TOOLS:
  - query_skill_data(sql: string): Execute a read query on skill data
  - insert_skill_data(table: string, data: object): Insert a new row
  - update_skill_data(table: string, id: string, data: object): Update a row
  - schedule_notification(message: string, at: datetime): Schedule a push
```

#### LLMGateway

Routes to the optimal model based on task requirements.

```typescript
interface LLMGateway {
  complete(prompt: Prompt, options: ModelPreferences): Promise<LLMResponse>;
}

interface ModelPreferences {
  taskType: 'simple_qa' | 'skill_execution' | 'skill_generation' | 'complex_reasoning' | 'data_analysis';
  maxLatencyMs?: number;
  maxTokens?: number;
  streaming: boolean;
}

interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  model: string;          // which model was actually used
  usage: { promptTokens: number; completionTokens: number; };
  latencyMs: number;
}
```

**Model routing strategy** (from PRD Section 6.4, made concrete):

| Task Type | Primary Model | Fallback | Rationale |
|---|---|---|---|
| `simple_qa` | Haiku-class | — | "What time is my order?" — fast, cheap |
| `skill_execution` | Sonnet-class | Haiku-class | Most skill interactions — good balance |
| `skill_generation` | Sonnet-class | Opus-class | Creating new skills — needs strong instruction following |
| `complex_reasoning` | Opus-class | Sonnet-class | Multi-step analysis, cross-skill queries |
| `data_analysis` | Sonnet-class | Opus-class | Aggregations, trends, summaries over data |

#### SkillProposer

Determines when to propose a new skill to the user.

```typescript
interface SkillProposer {
  evaluate(
    message: UserMessage,
    existingSkills: SkillDefinition[],
    recentHistory: Message[]
  ): Promise<SkillProposal | null>;
}

interface SkillProposal {
  proposedName: string;
  description: string;           // plain English explanation for the user
  triggerExamples: string[];     // "You could say things like..."
  suggestedInputFields: FieldSuggestion[];
  suggestedSchedule?: string;    // "daily at 7pm", etc.
  clarifyingQuestions: string[]; // questions to ask before creating
  confidence: number;
}
```

**When to propose** (answering the PRD's open question in Section 12):

A skill proposal is triggered when ALL of:
1. No existing skill matched the message (or matched with low confidence)
2. The message implies a **repeatable** need (not a one-off question)
3. The user hasn't dismissed a similar proposal in the last 7 days

Signals of repeatability:
- Time-based language: "every morning", "remind me weekly", "at 3pm daily"
- Tracking language: "keep track of", "log", "record"
- Template language: "draft a", "write a", "create a" (for the same type of thing)
- Aggregation language: "how many", "which ones", "summarize"

This is conservative by default — it only proposes when it's clearly a repeatable need. The PRD's open question about "how aggressive should proposals be" is answered: **not aggressive at launch, aggressive later** once we have data on proposal acceptance rates.

### 3. Side Effects Model

The Orchestrator returns `SideEffect[]` alongside the response. Side effects are processed asynchronously (not on the hot path):

```typescript
type SideEffect =
  | { type: 'memory_write'; facts: MemoryFact[] }
  | { type: 'skill_proposal'; proposal: SkillProposal }
  | { type: 'skill_data_write'; table: string; operation: 'insert' | 'update' | 'delete'; data: any }
  | { type: 'schedule_notification'; message: string; at: Date; recurring?: CronExpression }
  | { type: 'analytics_event'; event: string; properties: Record<string, any> };
```

This separation means:
- The user gets their response as fast as possible (hot path = match + compose + LLM + format)
- Memory writes, analytics, and notification scheduling happen in background workers
- If a side effect fails, it doesn't break the conversation

### 4. Error Handling Strategy

Each interface defines its failure modes:

| Component | Failure Mode | Handling |
|---|---|---|
| SkillMatcher | No match found | Not an error — fall through to SkillProposer or general conversation |
| SkillMatcher | LLM classification timeout | Fall back to rule-based matching only. Log for monitoring. |
| PromptComposer | Context too large for model window | Truncate conversation history (oldest first), summarize RAG results. Never truncate skill instructions. |
| LLMGateway | Primary model unavailable | Fall back to secondary model (see routing table). If all fail, return "I'm having trouble right now, try again in a moment." |
| LLMGateway | Response fails safety filter | Return generic safe response. Log for review. |
| SkillProposer | LLM timeout | Skip proposal silently — not critical path. Try again on next unmatched message. |
| MemoryExtractor | Extraction fails | Skip silently — memory is additive, missing one extraction isn't critical. |

### 5. Testability Contract

Each interface MUST be testable in isolation with no external dependencies:

| Interface | Test Strategy |
|---|---|
| SkillMatcher | Unit: pass message + skill list, assert correct match. No LLM needed for fast-path tests. |
| PromptComposer | Unit: pass composition input, assert prompt structure. Pure function — no I/O. |
| LLMGateway | Integration: mock LLM responses. Unit: test model selection logic. |
| SkillProposer | Unit: test repeatability detection with example messages. Integration: test with real LLM. |
| MessageOrchestrator | Integration: mock all downstream interfaces, test the wiring. |
| ResponseProcessor | Unit: test safety filtering and format validation with sample responses. |
| MemoryExtractor | Unit: test fact extraction from sample conversations. |

The Orchestrator's integration test should cover the full flow with mocked interfaces — asserting that the right interfaces are called in the right order with the right arguments.

### 6. Module Structure

```
src/
  bot-runtime/
    orchestrator/
      message-orchestrator.ts       # The thin coordinator
      types.ts                      # Shared types (OrchestratorInput, etc.)
    skill-matcher/
      skill-matcher.ts              # Interface implementation
      fast-matcher.ts               # Rule-based trigger pattern matching
      llm-matcher.ts                # LLM-based intent classification
      types.ts
    prompt-composer/
      prompt-composer.ts            # Interface implementation
      templates/                    # Prompt templates per skill type
      types.ts
    skill-proposer/
      skill-proposer.ts             # Interface implementation
      repeatability-detector.ts     # Heuristics for repeatable needs
      types.ts
    response-processor/
      response-processor.ts
      safety-filter.ts
      format-validator.ts
    memory-extractor/
      memory-extractor.ts
      fact-parser.ts
  llm-gateway/
    llm-gateway.ts                  # Interface implementation
    model-router.ts                 # Task type → model selection
    providers/
      anthropic.ts
      openai.ts
      google.ts
    types.ts
  skill-engine/
    skill-validator.ts              # See Spec #3
    skill-creator.ts                # Generates Skill Definition Objects
    schema-generator.ts             # JSON Schema → DDL (from Spec #1)
    types.ts
```
