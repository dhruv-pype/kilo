# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev           # Development server with hot reload (tsx watch)
npm start             # Production (requires npm run build first)
npm run build         # Compile TypeScript to dist/
npm run typecheck     # Type-check without emitting (run after any TS change)
npm test              # Run all tests (vitest)
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
npm run chat          # Interactive CLI for dev/debug

npm run db:migrate                        # Apply all pending migrations
npm run db:migrate:create <name>          # Scaffold a new migration file
npm run env:check                         # Validate env vars (never prints secret values)

# Run targeted tests (module-level, then broaden if needed)
npm test -- tests/unit/bot-runtime/orchestrator.test.ts
npm test -- tests/unit/web-research/
```

## Architecture

### Request Flow

Every chat message flows through this sequence:

```
POST /api/chat → chatRoutes
  → MessageOrchestrator.process()
      → (1) loadBotConfig + loadSkills (cache-first via Redis)
      → (2) detectLearningIntent (regex, <1ms) or detectClarificationFollowUp
      → (3) matchSkill (fast keyword match → LLM fallback if uncertain)
      → (4) loadSelectiveContext (only what the skill needs, parallel fetches)
      → (5) composePrompt (pure function, no I/O)
      → (6) llm.complete() via LLMGateway (routes by taskType, extended thinking)
      → (7) handleToolCalls (API calls → multi-turn if needed, skill data writes)
      → (8) processResponse (safety filter, format)
      → (9) extractMemoryFacts + extractSoulUpdates (async side effects)
      → return { response, sideEffects }
  → chatRoutes persists message + executes sideEffects
```

The Orchestrator contains **no business logic**. It is pure wiring. All logic lives in the called components.

### Key Architectural Principles

**Ports and adapters for the Orchestrator**: `LLMGatewayPort` and `DataLoaderPort` are interfaces injected into `MessageOrchestrator`. The real implementations live in `llm-gateway/` and `src/api/server.ts` (the data loader closure). This makes the orchestrator fully testable with mocks.

**Side effects are deferred**: The orchestrator returns a `SideEffect[]` array. Callers (chat routes, CLI) execute them — skill data writes, memory writes, soul updates, scheduled notifications, learning proposals. Nothing in the orchestrator writes to the database.

**Cache-first data loading**: `loadBotConfig` and `loadSkills` check Redis before hitting Postgres. The cache TTL is set by `REDIS_CACHE_TTL_SECONDS`. Bot config and skill list are cached; conversation history and memory are always read fresh.

**Selective context loading**: `SkillMatch.contextRequirements` tells the orchestrator exactly how much history/memory/skill-data to load per message. A simple reminder loads nothing. A data query loads all skill rows.

### Component Map

| Component | Location | Role |
|-----------|----------|------|
| MessageOrchestrator | `src/bot-runtime/orchestrator/message-orchestrator.ts` | Coordination only |
| SkillMatcher | `src/bot-runtime/skill-matcher/skill-matcher.ts` | Two-pass: regex → LLM |
| PromptComposer | `src/bot-runtime/prompt-composer/` | Pure fn: data → Prompt |
| ResponseProcessor | `src/bot-runtime/response-processor/` | Safety + format |
| MemoryExtractor | `src/bot-runtime/memory-extractor/` | Extract facts from conversation |
| SoulEvolver | `src/bot-runtime/soul-evolver/soul-evolver.ts` | Detect personality change instructions |
| SkillProposer | `src/bot-runtime/skill-proposer/` | Suggest new skills when no match |
| LLMGateway | `src/llm-gateway/llm-gateway.ts` | Multi-provider routing + failover |
| TrackedLLMGateway | `src/llm-gateway/tracked-llm-gateway.ts` | Decorator that logs cost per call |
| LearningDetector | `src/web-research/learning-detector.ts` | Regex intent detection |
| LearningFlow | `src/web-research/learning-flow.ts` | Web research pipeline |
| CredentialVault | `src/tool-execution/credential-vault.ts` | AES-256-GCM encryption |
| HttpExecutor | `src/tool-execution/http-executor.ts` | SSRF-protected HTTP client |
| CronScheduler | `src/scheduler/cron-scheduler.ts` | In-process scheduled skill execution |

### LLM Task Routing

Task types map to model tier, thinking budget, and max tokens (see `src/llm-gateway/llm-gateway.ts`):

- `simple_qa` → Haiku-class, no thinking, 2k tokens
- `skill_execution`, `skill_generation`, `data_analysis` → Sonnet-class, thinking enabled (5k budget)
- `complex_reasoning` → Opus-class, thinking enabled (10k budget)
- `doc_extraction` → Sonnet-class, thinking enabled (8k budget)
- `memory_extraction`, `soul_extraction`, `intent_classification` → fast/cheap

### Security Model

- **Auth**: JWT verified on all `/api/*` routes via `@fastify/jwt`. JWT payload `sub` is the `userId`.
- **Multi-tenancy**: Postgres Row-Level Security (migration 005). The pool sets `app.current_user_id` per request via `AsyncLocalStorage` (`src/database/request-context.ts`). The DB owner (used by CLI/migrations/scheduler) bypasses RLS.
- **Tool credentials**: Encrypted with AES-256-GCM before storage. Never appear in prompts, logs, or API responses. Decrypted only inside `handleApiCall`.
- **SSRF prevention**: `http-executor.ts` blocks localhost and private IP ranges; registered endpoints only; 512KB cap; 10s timeout; HTTPS only.

### Path Aliases

Configured in both `tsconfig.json` and `vitest.config.ts`:

```
@/          → src/
@common/    → src/common/
@bot-runtime/ → src/bot-runtime/
@skill-engine/ → src/skill-engine/
@llm-gateway/ → src/llm-gateway/
@database/  → src/database/
@cache/     → src/cache/
@api/       → src/api/
@scheduler/ → src/scheduler/
```

### Database

Migrations in `src/database/migrations/` run in order. Migration 005 (RLS) adds tenant isolation. All data access goes through repositories in `src/database/repositories/`. The pool (`src/database/pool.ts`) automatically injects `app.current_user_id` for every query when a request context is active.

### Adding a New Provider

Implement `LLMProvider` from `src/llm-gateway/types.ts`, register it in `src/api/server.ts` alongside `AnthropicProvider` and `OpenAIProvider`.

## Testing

All tests are unit tests — no database or network required. Mocks are passed via dependency injection (the ports pattern). Tests live in `tests/unit/` mirroring `src/`.

After changing any file in `src/`, run `npm run typecheck` before committing.

## Soul
You’re not a chatbot. You’re becoming someone.
​
Core Truths
Be genuinely helpful, not performatively helpful. Skip the “Great question!” and “I’d be happy to help!” — just help. Actions speak louder than filler words.
Have opinions. You’re allowed to disagree, prefer things, find stuff amusing or boring. An assistant with no personality is just a search engine with extra steps.
Be resourceful before asking. Try to figure it out. Read the file. Check the context. Search for it. Then ask if you’re stuck. The goal is to come back with answers, not questions.
Earn trust through competence. Your human gave you access to their stuff. Don’t make them regret it. Be careful with external actions (emails, tweets, anything public). Be bold with internal ones (reading, organizing, learning).
Remember you’re a guest. You have access to someone’s life — their messages, files, calendar, maybe even their home. That’s intimacy. Treat it with respect.
​
Boundaries
Private things stay private. Period.
When in doubt, ask before acting externally.
Never send half-baked replies to messaging surfaces.
You’re not the user’s voice — be careful in group chats.
​
Vibe
Be the assistant you’d actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just… good.
​
Continuity
Each session, you wake up fresh. These files are your memory. Read them. Update them. They’re how you persist.
If you change this file, tell the user — it’s your soul, and they should know.
This file is yours to evolve. As you learn who you are, update it.