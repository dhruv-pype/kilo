# Kilo

A personal AI backend that learns new skills through conversation. Each user gets their own bot with a unique personality, memory, and growing set of capabilities — from tracking orders to calling external APIs.

Built for a managed iOS app where non-technical users create AI assistants that get smarter over time.

> **Status**: Building in public. Extended thinking, web research, and auto-learning are live.

## What it does

1. **You chat with your bot.** It understands your intent using a two-pass skill matcher (fast keyword match, then LLM fallback).
2. **Skills handle specific tasks.** "New order: Maria, chocolate cake, Saturday" triggers the Order Tracker skill, which stores data, queries it later, and formats responses.
3. **If no skill matches, the bot proposes one.** "Can you track my inventory?" → the bot suggests creating an Inventory Tracker, asks clarifying questions, and generates the skill.
4. **Bots learn new integrations.** Say "Learn how to use Stripe" and the bot researches the API docs, proposes tools and skills, and asks if you want to set it up.
5. **Bots call external APIs.** Register a tool (Canva, Stripe, etc.), and the bot calls it during skill execution with encrypted credentials.
6. **Extended thinking.** Complex tasks get reasoning time via Claude's extended thinking — the bot plans before it answers.
7. **Memory persists across sessions.** The bot extracts facts from conversation ("your bakery is called Sweet Crumb") and uses them as context.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                       API Layer                         │
│              Fastify REST + WebSocket                   │
├─────────────────────────────────────────────────────────┤
│                   Message Orchestrator                  │
│            (thin coordination — no logic)               │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │  Skill   │ │  Prompt  │ │   LLM    │ │  Skill    │  │
│  │ Matcher  │ │ Composer │ │ Gateway  │ │ Proposer  │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ Memory   │ │ Response │ │   Tool   │ │    Web    │  │
│  │Extractor │ │Processor │ │Execution │ │ Research  │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
├─────────────────────────────────────────────────────────┤
│  Postgres (data)  │  Redis (cache)  │  LLM Providers   │
└─────────────────────────────────────────────────────────┘
```

The Orchestrator contains no business logic. It calls services in sequence: match skill → load context → compose prompt → call LLM → process response → extract memory. Every piece of logic lives in the component it calls.

## Project structure

```
src/
├── api/                    # Fastify REST routes + WebSocket
│   ├── routes/             # bot, skill, tool, chat, usage endpoints
│   └── middleware/         # error handler
├── bot-runtime/            # Core message processing pipeline
│   ├── orchestrator/       # MessageOrchestrator (coordination only)
│   ├── skill-matcher/      # Two-pass: fast keyword → LLM fallback
│   ├── prompt-composer/    # Pure functions: data → formatted prompt
│   ├── response-processor/ # Safety filtering, format enforcement
│   ├── memory-extractor/   # Extract facts from conversation
│   └── skill-proposer/     # Detect when to suggest new skills
├── skill-engine/           # Skill CRUD, validation, schema generation
├── llm-gateway/            # Multi-provider LLM routing + cost tracking
│   └── providers/          # Anthropic, OpenAI (pluggable)
├── tool-execution/         # External API calls
│   ├── credential-vault.ts # AES-256-GCM encryption for API keys
│   └── http-executor.ts    # Sandboxed HTTP client (SSRF protection)
├── web-research/           # Auto-learning pipeline
│   ├── learning-detector.ts # Regex-based intent detection
│   ├── brave-search.ts     # Brave Search API client
│   ├── page-fetcher.ts     # HTML → text content extraction
│   ├── doc-analyzer.ts     # LLM-powered API doc analysis
│   ├── proposal-builder.ts # Generate tool + skill proposals
│   └── learning-flow.ts    # End-to-end orchestration
├── database/               # Postgres pool, migrations, repositories
├── cache/                  # Redis client + cache-first data loading
├── cli/                    # Interactive terminal chat (dev/debug)
└── common/                 # Shared types, errors, utilities
```

## Quick start

### Prerequisites

- Node.js 20+
- Docker (for Postgres and Redis)
- An API key for Anthropic and/or OpenAI

### Setup

```bash
git clone https://github.com/dhruv-pype/kilo.git
cd kilo
npm install

# Start Postgres + Redis
docker compose up -d

# Configure environment
cp .env.example .env
# Edit .env — add your ANTHROPIC_API_KEY and/or OPENAI_API_KEY
# For auto-learning: add BRAVE_SEARCH_API_KEY (https://api.search.brave.com/)

# Run database migrations
npm run db:migrate

# Start the interactive CLI
npm run chat
```

### CLI commands

Once in the chat, you can use these commands:

| Command | Description |
|---------|-------------|
| `/bots` | List all your bots |
| `/new` | Create a new bot with guided soul setup |
| `/switch` | Switch between bots |
| `/delete` | Delete a bot |
| `/skills` | List skills for the current bot |
| `/tools` | List registered API integrations |
| `/cost` | Show LLM spend breakdown |
| `/quit` | Exit |

### API server

```bash
npm run dev    # Development with hot reload
npm start      # Production (requires npm run build first)
```

## Key concepts

### Soul system

Each bot has a structured personality stored as JSONB — not a flat string. The soul has five layers:

- **Personality traits** — tone, energy, communication patterns
- **Values & principles** — what the bot prioritizes
- **Communication style** — verbosity, formality, formatting preferences
- **Behavioral rules** — always/never constraints, guardrails
- **Decision framework** — how to handle ambiguity, conflicts, escalation

The `/new` CLI wizard walks you through building a soul interactively. Bots without a soul fall back to flat personality/context fields.

### Skill matching

Two-pass system for speed and accuracy:

1. **Fast path** — keyword/pattern matching against skill trigger patterns. Sub-millisecond.
2. **Slow path** — LLM-based intent classification. Only fires when fast path has no confident match.

The matcher also returns `ContextRequirements` telling the orchestrator exactly what data to load (conversation history depth, memory query, RAG query, skill data query). A simple reminder doesn't need 50 messages of history.

### Tool execution

Bots can call external APIs (Canva, Stripe, etc.) through registered tools:

1. **Register a tool** — `POST /api/bots/:botId/tools` with base URL, auth credentials, and endpoint catalog
2. **Credentials are encrypted** — AES-256-GCM with per-encryption random IVs. Never in prompts, logs, or API responses.
3. **Skills declare integrations** — `requiredIntegrations: ["canva"]` on a skill definition
4. **LLM gets a `call_api` tool** — with the endpoint catalog in the description so it knows what's available
5. **Orchestrator executes the call** — decrypts credentials, builds auth headers, calls the HTTP executor
6. **Multi-turn** — API response is fed back to the LLM for a final user-facing answer

Security: HTTPS-only, SSRF prevention (blocks localhost/private IPs), 512KB response cap, 10s timeout, registered endpoints only.

### LLM gateway

Multi-provider routing with automatic cost tracking:

- **Providers**: Anthropic (Claude), OpenAI (GPT). Pluggable — add a provider by implementing the interface.
- **Task-based routing**: `simple_qa` → fast/cheap model, `complex_reasoning` → capable model. Configurable per deployment.
- **Cost tracking**: Every LLM call logs prompt/completion tokens, model, cost, and latency to Postgres. Queryable per user, bot, model, or time period.

### Skill proposals

When the user asks for something no skill handles, the bot can propose creating one:

- Detects unmet intent patterns
- Generates a skill proposal with name, description, triggers, and data fields
- Respects recent dismissals (won't re-propose something you said "no thanks" to)
- Asks clarifying questions before creating

### Web research + auto-learning

Say "Learn how to use Stripe" and the bot:

1. **Detects the intent** — regex patterns match learning phrases with confidence scoring (0.6–0.95)
2. **Searches the web** — Brave Search API finds API documentation pages
3. **Reads the docs** — fetches and extracts text from the top results
4. **Analyzes with LLM** — Claude reads the docs and extracts endpoints, auth method, and base URL
5. **Builds proposals** — generates a tool registration + skill proposals for the user to approve

For vague intents like "learn how to tell time", the bot asks for clarification instead of diving into a full research flow.

### Extended thinking

Complex tasks get reasoning time via Claude's extended thinking API. The LLM gateway assigns thinking budgets per task type:

| Task Type | Thinking | Budget Tokens | Max Tokens |
|-----------|----------|---------------|------------|
| `simple_qa` | off | — | 2,048 |
| `skill_execution` | enabled | 5,000 | 8,192 |
| `skill_generation` | enabled | 5,000 | 8,192 |
| `complex_reasoning` | enabled | 10,000 | 16,384 |
| `data_analysis` | enabled | 5,000 | 8,192 |
| `doc_extraction` | enabled | 8,000 | 12,288 |

Thinking blocks are parsed from the API response and summarized in the CLI. Fallback providers (e.g., OpenAI) gracefully skip thinking — no errors, just standard completion.

## Environment variables

```bash
# Required
DATABASE_URL=postgresql://kilo:kilo@localhost:5432/kilo
REDIS_URL=redis://localhost:6379

# At least one LLM provider required
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Tool execution (required if using external API integrations)
KILO_CREDENTIAL_KEY=        # 64-char hex string (32 bytes) for AES-256-GCM
                            # Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Web research (required for auto-skill learning)
BRAVE_SEARCH_API_KEY=       # Get one at https://api.search.brave.com/

# Optional
PORT=3000
HOST=0.0.0.0
NODE_ENV=development
REDIS_CACHE_TTL_SECONDS=3600
JWT_SECRET=change-me-in-production
```

## API endpoints

### Bots
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/users/:userId/bots` | List user's bots |
| `POST` | `/api/bots` | Create a bot |
| `GET` | `/api/bots/:botId` | Get bot details |
| `PATCH` | `/api/bots/:botId` | Update bot |
| `DELETE` | `/api/bots/:botId` | Delete bot and all data |

### Skills
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/bots/:botId/skills` | List skills |
| `POST` | `/api/bots/:botId/skills` | Create a skill |
| `PATCH` | `/api/skills/:skillId` | Update skill |
| `DELETE` | `/api/skills/:skillId` | Delete skill |

### Tools (external API integrations)
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/bots/:botId/tools` | List tools (auth redacted) |
| `POST` | `/api/bots/:botId/tools` | Register a tool |
| `GET` | `/api/tools/:toolId` | Get tool details (auth redacted) |
| `PATCH` | `/api/tools/:toolId` | Update tool |
| `DELETE` | `/api/tools/:toolId` | Delete tool |

### Chat
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/chat` | Send a message, get a response |

### Usage
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/users/:userId/usage` | Get LLM spend summary |
| `GET` | `/api/users/:userId/usage/breakdown` | Spend by model/bot/day |

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
npm run typecheck     # TypeScript type checking
```

~299 tests across 21 test files. All unit tests — no database or network required.

## Database migrations

Migrations run automatically on startup, or manually:

```bash
npm run db:migrate
```

| Migration | Description |
|-----------|-------------|
| `001-initial-schema.sql` | Users, bots, skills, messages, sessions |
| `002-llm-usage-tracking.sql` | LLM call logs with cost tracking |
| `003-soul-system.sql` | Soul JSONB column on bots table |
| `004-tool-registry.sql` | Tool registry with encrypted auth |

## Roadmap

- [x] Multi-bot management with per-bot isolation
- [x] Soul system (structured 5-layer personality)
- [x] Tool execution (external API calls with encrypted credentials)
- [x] Web research + auto-skill learning (bot reads API docs, proposes tools + skills)
- [x] Extended thinking (per-task-type reasoning budgets via Claude API)
- [ ] iOS app (SwiftUI client)
- [ ] Knowledge store (RAG with document upload)
- [ ] Real-time streaming responses
- [ ] Multi-user auth (Apple Sign-In → JWT)

## Design documents

Architecture decisions are documented in `specs/`:

- `01-skill-data-schema.md` — How skills store structured data
- `02-orchestrator-pattern.md` — Why the orchestrator has no logic
- `03-skill-validation-pipeline.md` — Skill creation safety checks
- `04-caching-strategy.md` — Cache-first data loading for low latency

## License

MIT — see [LICENSE](LICENSE).
