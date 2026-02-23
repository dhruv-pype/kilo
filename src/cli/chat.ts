import dotenv from 'dotenv';
import readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import { initPool, query as dbQuery } from '../database/pool.js';
import { initRedis } from '../cache/redis-client.js';
import { runMigrations } from '../database/migrate.js';
import * as botRepo from '../database/repositories/bot-repository.js';
import * as messageRepo from '../database/repositories/message-repository.js';
import * as usageRepo from '../database/repositories/usage-repository.js';
import { MessageOrchestrator } from '../bot-runtime/orchestrator/message-orchestrator.js';
import type { DataLoaderPort } from '../bot-runtime/orchestrator/message-orchestrator.js';
import { LLMGateway, defaultModelRoutes } from '../llm-gateway/llm-gateway.js';
import { TrackedLLMGateway } from '../llm-gateway/tracked-llm-gateway.js';
import { AnthropicProvider } from '../llm-gateway/providers/anthropic.js';
import { OpenAIProvider } from '../llm-gateway/providers/openai.js';
import { getCachedBotConfig, setCachedBotConfig, getCachedSkills, setCachedSkills } from '../cache/cache-service.js';
import * as skillRepo from '../database/repositories/skill-repository.js';
import * as toolRepo from '../database/repositories/tool-registry-repository.js';
import { messageId, sessionId, userId } from '../common/types/ids.js';
import type { BotId, UserId } from '../common/types/ids.js';
import type { BotConfig } from '../common/types/bot.js';
import type { SoulDefinition } from '../common/types/soul.js';
import type { Attachment } from '../common/types/message.js';

// ─── Colors for terminal output ─────────────────────────────────

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const BLUE = '\x1b[34m';
const RED = '\x1b[31m';

function think(label: string, detail: string): void {
  console.log(`  ${DIM}${MAGENTA}[thinking]${RESET} ${DIM}${label}:${RESET} ${DIM}${detail}${RESET}`);
}

function step(icon: string, msg: string): void {
  console.log(`  ${DIM}${icon} ${msg}${RESET}`);
}

// ─── CLI Helpers ────────────────────────────────────────────────

function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
}

function printBanner(bot: BotConfig, sessionIdStr: string): void {
  console.log('');
  console.log(`  ${BOLD}${CYAN}╔══════════════════════════════════════════════╗${RESET}`);
  console.log(`  ${BOLD}${CYAN}║${RESET}  ${BOLD}Kilo CLI Chat${RESET}  ${DIM}— thinking mode ON${RESET}           ${BOLD}${CYAN}║${RESET}`);
  console.log(`  ${BOLD}${CYAN}╠══════════════════════════════════════════════╣${RESET}`);
  console.log(`  ${BOLD}${CYAN}║${RESET}  ${DIM}Bot:${RESET}     ${bot.name} ${DIM}(${bot.botId.toString().slice(0, 8)}...)${RESET}`);
  console.log(`  ${BOLD}${CYAN}║${RESET}  ${DIM}Session:${RESET} ${sessionIdStr.slice(0, 8)}...`);
  console.log(`  ${BOLD}${CYAN}║${RESET}  ${DIM}Commands:${RESET} /bots /new /switch /delete`);
  console.log(`  ${BOLD}${CYAN}║${RESET}  ${DIM}         /skills /tools /cost /quit${RESET}`);
  console.log(`  ${BOLD}${CYAN}╚══════════════════════════════════════════════╝${RESET}`);
  console.log('');
}

function displayBotList(bots: BotConfig[], activeBot?: BotConfig): void {
  console.log('');
  console.log(`  ${BOLD}Your bots:${RESET}`);
  for (let i = 0; i < bots.length; i++) {
    const b = bots[i];
    const marker = activeBot && b.botId === activeBot.botId ? ` ${GREEN}<- active${RESET}` : '';
    console.log(`  ${DIM}${i + 1}.${RESET} ${BOLD}${b.name}${RESET} ${DIM}(${b.botId.toString().slice(0, 8)}...)${RESET}${marker}`);
    console.log(`     ${DIM}${b.description}${RESET}`);
  }
  console.log('');
}

// ─── Instrumented Orchestrator ──────────────────────────────────

class InstrumentedOrchestrator {
  constructor(
    private readonly orchestrator: MessageOrchestrator,
    private readonly trackedGateway: TrackedLLMGateway,
  ) {}

  async chat(
    content: string,
    botIdVal: string,
    userIdVal: string,
    sessionIdVal: string,
  ) {
    const msgId = uuidv4();

    this.trackedGateway.setContext({
      userId: userIdVal,
      botId: botIdVal,
      sessionId: sessionIdVal,
      messageId: msgId,
    });

    const userMsg = {
      messageId: messageId(msgId),
      sessionId: sessionId(sessionIdVal),
      botId: botIdVal as BotId,
      userId: userIdVal as UserId,
      content,
      attachments: [] as Attachment[],
      timestamp: new Date(),
    };

    await messageRepo.insertMessage({
      sessionId: sessionIdVal,
      botId: botIdVal,
      role: 'user',
      content,
    });

    console.log('');
    step('🧠', 'Processing your message...');

    const startMs = Date.now();

    const result = await this.orchestrator.process({
      message: userMsg,
      botId: botIdVal as BotId,
      sessionId: sessionId(sessionIdVal),
    });

    const elapsed = Date.now() - startMs;

    await messageRepo.insertMessage({
      sessionId: sessionIdVal,
      botId: botIdVal,
      role: 'assistant',
      content: result.response.content,
      skillId: result.response.skillId as string | null,
    });

    console.log('');
    console.log(`  ${DIM}${CYAN}── thinking ──────────────────────────────────${RESET}`);

    if (result.response.skillId) {
      think('skill matched', `${result.response.skillId}`);
    } else {
      think('skill matched', 'none → general conversation');
    }

    for (const effect of result.sideEffects) {
      switch (effect.type) {
        case 'memory_write':
          for (const fact of effect.facts) {
            think('memory extracted', `${fact.key} = "${fact.value}" (${Math.round(fact.confidence * 100)}%)`);
          }
          break;
        case 'skill_proposal':
          think('skill proposed', `"${effect.proposal.proposedName}" (${Math.round(effect.proposal.confidence * 100)}% confidence)`);
          break;
        case 'skill_data_write':
          think('data write', `${effect.operation} → ${effect.table}`);
          break;
        case 'schedule_notification':
          think('notification', `"${effect.message}" at ${effect.at}`);
          break;
        case 'analytics_event':
          think('analytics', effect.event);
          break;
        case 'api_call':
          think('api call', `${effect.toolName} ${effect.endpoint} → ${effect.status === 0 ? 'FAILED' : effect.status} (${effect.latencyMs}ms)`);
          break;
      }
    }

    think('response format', result.response.format);
    think('latency', `${elapsed}ms total pipeline`);

    await new Promise((r) => setTimeout(r, 200));
    try {
      const usage = await usageRepo.getTotalSpend(userIdVal);
      think('total spend', `$${usage.totalCostUsd.toFixed(4)} (${usage.totalCalls} calls)`);
    } catch {
      think('total spend', '(tracking pending)');
    }

    console.log(`  ${DIM}${CYAN}──────────────────────────────────────────────${RESET}`);

    if (result.response.suggestedActions.length > 0) {
      console.log('');
      console.log(`  ${DIM}suggestions: ${result.response.suggestedActions.map(a => `[${a}]`).join(' ')}${RESET}`);
    }

    console.log('');
    console.log(`  ${GREEN}${BOLD}bot:${RESET} ${result.response.content}`);
    console.log('');

    return result;
  }
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  dotenv.config();

  const dbUrl = process.env.DATABASE_URL ?? 'postgresql://kilo:kilo@localhost:5432/kilo';
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
  const openaiKey = process.env.OPENAI_API_KEY ?? '';

  if (!anthropicKey && !openaiKey) {
    console.error(`${RED}Error: Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env${RESET}`);
    process.exit(1);
  }

  // Init infrastructure
  console.log(`${DIM}Connecting to Postgres...${RESET}`);
  initPool(dbUrl);

  console.log(`${DIM}Running migrations...${RESET}`);
  await runMigrations();

  console.log(`${DIM}Connecting to Redis...${RESET}`);
  initRedis(redisUrl);

  // LLM providers
  const providers = [
    new AnthropicProvider(anthropicKey),
    new OpenAIProvider(openaiKey),
  ].filter((p) => p.isAvailable());

  console.log(`${DIM}LLM providers: ${providers.map(p => p.name).join(', ')}${RESET}`);

  const llmGateway = new LLMGateway(providers, defaultModelRoutes());
  const trackedGateway = new TrackedLLMGateway(llmGateway);

  // Data loader
  const dataLoader: DataLoaderPort = {
    async loadBotConfig(id: string) {
      const cached = await getCachedBotConfig(id);
      if (cached) return cached;
      const config = await botRepo.getBotById(id);
      await setCachedBotConfig(id, config);
      return config;
    },
    async loadSkills(id: string) {
      const cached = await getCachedSkills(id);
      if (cached) return cached;
      const skills = await skillRepo.getActiveSkillsByBotId(id);
      await setCachedSkills(id, skills);
      return skills;
    },
    async loadConversationHistory(id, sid, depth) {
      return messageRepo.getRecentMessages(id, sid, depth);
    },
    async loadMemoryFacts() { return []; },
    async loadRAGResults() { return []; },
    async loadSkillData() { return { tableName: '', rows: [], totalCount: 0 }; },
    async loadTableSchemas() { return []; },
    async loadRecentDismissals() { return []; },
    async loadTools(botIdVal: string, names: string[]) {
      return toolRepo.getToolsByNames(botIdVal, names);
    },
  };

  const orchestrator = new MessageOrchestrator(trackedGateway, dataLoader);
  const instrumented = new InstrumentedOrchestrator(orchestrator, trackedGateway);

  // ── User setup ──────────────────────────────────────────────
  const CLI_USER_UUID = '00000000-0000-4000-a000-000000000001';
  const testUserId = CLI_USER_UUID;

  await dbQuery(
    `INSERT INTO users (user_id, display_name, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING`,
    [CLI_USER_UUID, 'CLI User', 'cli@kilo.local'],
  );

  // ── Bot selection ───────────────────────────────────────────
  let bots: BotConfig[] = [];
  try {
    bots = await botRepo.getBotsByUserId(testUserId);
  } catch {
    // No bots yet
  }

  let bot: BotConfig | undefined;

  if (bots.length === 0) {
    console.log(`${DIM}Creating your first bot...${RESET}`);
    bot = await botRepo.createBot({
      userId: userId(testUserId),
      name: 'Kilo',
      description: 'Your personal AI assistant that learns new skills through conversation',
      personality: 'Friendly, efficient, proactive. You help small business owners manage their day-to-day.',
      context: 'The user is a small business owner. Learn their business name, hours, team size, and preferences through natural conversation.',
    });
  } else if (bots.length === 1) {
    bot = bots[0];
  } else {
    displayBotList(bots);

    const rlTemp = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const choice = await askQuestion(rlTemp, `  ${BLUE}Select a bot (1-${bots.length}): ${RESET}`);
    rlTemp.close();

    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < bots.length) {
      bot = bots[idx];
    } else {
      bot = bots[0];
      console.log(`  ${DIM}Invalid choice, defaulting to ${bot.name}${RESET}`);
    }
  }

  let currentSessionId = uuidv4();

  printBanner(bot!, currentSessionId);

  // ── REPL ────────────────────────────────────────────────────
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `  ${BLUE}you:${RESET} `,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // ── /quit ─────────────────────────────────────────────────
    if (input === '/quit' || input === '/exit' || input === '/q') {
      console.log(`\n  ${DIM}Goodbye!${RESET}\n`);
      process.exit(0);
    }

    // ── /bots ─────────────────────────────────────────────────
    if (input === '/bots') {
      try {
        const allBots = await botRepo.getBotsByUserId(testUserId);
        if (allBots.length === 0) {
          console.log(`\n  ${DIM}No bots yet. Use /new to create one.${RESET}\n`);
        } else {
          displayBotList(allBots, bot);
        }
      } catch (err) {
        console.log(`\n  ${RED}Error loading bots: ${(err as Error).message}${RESET}\n`);
      }
      rl.prompt();
      return;
    }

    // ── /new — Guided bot creation wizard with Soul ────────────
    if (input === '/new') {
      try {
        console.log('');
        console.log(`  ${BOLD}${CYAN}✨ Let's create a new bot!${RESET}`);
        console.log('');

        // 1. What should this bot do? (required → description)
        console.log(`  ${BOLD}What should this bot do?${RESET}`);
        console.log(`  ${DIM}(e.g., "handle customer support", "manage my schedule", "track inventory")${RESET}`);
        const description = await askQuestion(rl, `  ${BLUE}> ${RESET}`);
        if (!description) {
          console.log(`\n  ${RED}This is required — I need to know what the bot should do.${RESET}`);
          console.log(`  ${DIM}Try again with /new${RESET}\n`);
          rl.prompt();
          return;
        }

        // 2. Name (optional — auto-generate from description)
        console.log('');
        console.log(`  ${BOLD}What should we call this bot?${RESET}`);
        console.log(`  ${DIM}(press Enter to auto-name it)${RESET}`);
        let name = await askQuestion(rl, `  ${BLUE}> ${RESET}`);
        if (!name) {
          name = description
            .replace(/^(handle|manage|do|run|track|help with|take care of)\s+/i, '')
            .split(/\s+/)
            .slice(0, 3)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ') + ' Bot';
          console.log(`  ${DIM}→ "${name}"${RESET}`);
        }

        // 3. Personality — tone & energy
        console.log('');
        console.log(`  ${BOLD}How should it communicate?${RESET}`);
        console.log(`  ${DIM}Describe the tone (e.g., "warm", "direct", "playful") and energy (e.g., "calm", "enthusiastic")${RESET}`);
        const toneInput = await askQuestion(rl, `  ${BLUE}> ${RESET}`);

        // 4. Communication style
        console.log('');
        console.log(`  ${BOLD}How detailed should its responses be?${RESET}`);
        console.log(`  ${DIM}1. Concise  2. Balanced  3. Detailed${RESET}`);
        const verbosityChoice = await askQuestion(rl, `  ${BLUE}> ${RESET}`);
        const verbosity = verbosityChoice === '3' || verbosityChoice.startsWith('d')
          ? 'detailed' as const
          : verbosityChoice === '1' || verbosityChoice.startsWith('c')
            ? 'concise' as const
            : 'balanced' as const;

        console.log('');
        console.log(`  ${BOLD}How formal should it be?${RESET}`);
        console.log(`  ${DIM}1. Casual  2. Professional  3. Formal${RESET}`);
        const formalityChoice = await askQuestion(rl, `  ${BLUE}> ${RESET}`);
        const formality = formalityChoice === '3' || formalityChoice.startsWith('f')
          ? 'formal' as const
          : formalityChoice === '1' || formalityChoice.startsWith('c')
            ? 'casual' as const
            : 'professional' as const;

        // 5. Behavioral rules
        console.log('');
        console.log(`  ${BOLD}What should this bot ALWAYS do?${RESET}`);
        console.log(`  ${DIM}(comma-separated, e.g., "greet by name, confirm before taking action" — Enter to skip)${RESET}`);
        const alwaysInput = await askQuestion(rl, `  ${BLUE}> ${RESET}`);
        const always = alwaysInput ? alwaysInput.split(',').map((s) => s.trim()).filter(Boolean) : [];

        console.log('');
        console.log(`  ${BOLD}What should this bot NEVER do?${RESET}`);
        console.log(`  ${DIM}(comma-separated, e.g., "give medical advice, share customer data" — Enter to skip)${RESET}`);
        const neverInput = await askQuestion(rl, `  ${BLUE}> ${RESET}`);
        const never = neverInput ? neverInput.split(',').map((s) => s.trim()).filter(Boolean) : [];

        // 6. Business context
        console.log('');
        console.log(`  ${BOLD}What should it know about your business?${RESET}`);
        console.log(`  ${DIM}(e.g., "We're a bakery open 7am-3pm, team of 5, located in Austin TX")${RESET}`);
        const businessContext = await askQuestion(rl, `  ${BLUE}> ${RESET}`);

        // 7. What to call the user
        console.log('');
        console.log(`  ${BOLD}What should it call you?${RESET}`);
        console.log(`  ${DIM}(e.g., "Boss", "Chef", your name — press Enter to skip)${RESET}`);
        const callMe = await askQuestion(rl, `  ${BLUE}> ${RESET}`);

        // Build context string
        let context = businessContext || '';
        if (callMe) {
          context = context
            ? `${context}\nAddress the user as "${callMe}".`
            : `Address the user as "${callMe}".`;
        }

        // Parse tone/energy from free-form input
        const toneWords = toneInput.toLowerCase().split(/[\s,]+/).filter(Boolean);
        const tone = toneWords[0] || 'friendly';
        const energy = toneWords.length > 1 ? toneWords.slice(1).join(' ') : 'balanced';

        // Build soul
        const soul: SoulDefinition = {
          personalityTraits: {
            tone,
            energy,
            patterns: [],
          },
          values: {
            priorities: [],
            beliefs: [],
          },
          communicationStyle: {
            verbosity,
            formality,
            formatting: [],
          },
          behavioralRules: {
            always,
            never,
            guardrails: [],
          },
          decisionFramework: {
            ambiguity: 'Ask one clarifying question, then proceed with best guess',
            conflictResolution: '',
            escalation: '',
          },
        };

        const newBot = await botRepo.createBot({
          userId: userId(testUserId),
          name,
          description,
          personality: `${tone}, ${energy}`,
          context: context || `You are ${name}. ${description}.`,
          soul,
        });

        console.log('');
        console.log(`  ${GREEN}${BOLD}✅ Bot "${newBot.name}" created with soul!${RESET}`);

        // Auto-switch to the new bot
        bot = newBot;
        currentSessionId = uuidv4();
        console.log(`  ${DIM}Switching to ${bot.name} now...${RESET}`);
        printBanner(bot, currentSessionId);
      } catch (err) {
        console.log(`\n  ${RED}Error creating bot: ${(err as Error).message}${RESET}\n`);
      }
      rl.prompt();
      return;
    }

    // ── /switch ───────────────────────────────────────────────
    if (input === '/switch') {
      try {
        const allBots = await botRepo.getBotsByUserId(testUserId);
        if (allBots.length <= 1) {
          console.log(`\n  ${DIM}You only have one bot. Use /new to create another.${RESET}\n`);
          rl.prompt();
          return;
        }

        displayBotList(allBots, bot);

        const choice = await askQuestion(rl, `  ${BLUE}Switch to bot (1-${allBots.length}): ${RESET}`);
        const idx = parseInt(choice, 10) - 1;

        if (idx < 0 || idx >= allBots.length) {
          console.log(`\n  ${RED}Invalid choice.${RESET}\n`);
          rl.prompt();
          return;
        }

        if (allBots[idx].botId === bot!.botId) {
          console.log(`\n  ${DIM}Already chatting with ${bot!.name}.${RESET}\n`);
          rl.prompt();
          return;
        }

        bot = allBots[idx];
        currentSessionId = uuidv4();
        printBanner(bot, currentSessionId);
      } catch (err) {
        console.log(`\n  ${RED}Error switching bot: ${(err as Error).message}${RESET}\n`);
      }
      rl.prompt();
      return;
    }

    // ── /delete ───────────────────────────────────────────────
    if (input === '/delete') {
      try {
        const allBots = await botRepo.getBotsByUserId(testUserId);
        if (allBots.length === 0) {
          console.log(`\n  ${DIM}No bots to delete.${RESET}\n`);
          rl.prompt();
          return;
        }

        if (allBots.length === 1) {
          console.log(`\n  ${RED}Can't delete your only bot. Create another one first with /new.${RESET}\n`);
          rl.prompt();
          return;
        }

        displayBotList(allBots, bot);

        const choice = await askQuestion(rl, `  ${BLUE}Delete bot (1-${allBots.length}): ${RESET}`);
        const idx = parseInt(choice, 10) - 1;

        if (idx < 0 || idx >= allBots.length) {
          console.log(`\n  ${RED}Invalid choice.${RESET}\n`);
          rl.prompt();
          return;
        }

        const target = allBots[idx];

        const confirm = await askQuestion(rl, `  ${YELLOW}Delete "${target.name}" and all its data? (yes/no): ${RESET}`);
        if (confirm.toLowerCase() !== 'yes') {
          console.log(`\n  ${DIM}Cancelled.${RESET}\n`);
          rl.prompt();
          return;
        }

        await botRepo.deleteBot(target.botId as string);
        console.log(`\n  ${GREEN}Bot "${target.name}" deleted.${RESET}`);

        if (target.botId === bot!.botId) {
          const remaining = await botRepo.getBotsByUserId(testUserId);
          bot = remaining[0];
          currentSessionId = uuidv4();
          console.log(`  ${DIM}Switched to ${bot.name}.${RESET}`);
          printBanner(bot, currentSessionId);
        } else {
          console.log('');
        }
      } catch (err) {
        console.log(`\n  ${RED}Error deleting bot: ${(err as Error).message}${RESET}\n`);
      }
      rl.prompt();
      return;
    }

    // ── /skills ───────────────────────────────────────────────
    if (input === '/skills') {
      try {
        const skills = await skillRepo.getActiveSkillsByBotId(bot!.botId as string);
        if (skills.length === 0) {
          console.log(`\n  ${DIM}No skills yet. Chat with your bot and it'll propose some!${RESET}\n`);
        } else {
          console.log(`\n  ${BOLD}Skills for ${bot!.name}:${RESET}`);
          for (const s of skills) {
            console.log(`  ${DIM}•${RESET} ${s.name} — ${s.description}`);
            console.log(`    ${DIM}triggers: ${s.triggerPatterns.join(', ')}${RESET}`);
          }
          console.log('');
        }
      } catch (err) {
        console.log(`\n  ${RED}Error loading skills: ${(err as Error).message}${RESET}\n`);
      }
      rl.prompt();
      return;
    }

    // ── /tools ────────────────────────────────────────────────
    if (input === '/tools') {
      try {
        const tools = await toolRepo.getToolsByBotId(bot!.botId as string);
        if (tools.length === 0) {
          console.log(`\n  ${DIM}No tools registered. Use the API to register external integrations.${RESET}\n`);
        } else {
          console.log(`\n  ${BOLD}Tools for ${bot!.name}:${RESET}`);
          for (const t of tools) {
            console.log(`  ${DIM}•${RESET} ${BOLD}${t.name}${RESET} — ${t.description}`);
            console.log(`    ${DIM}base: ${t.baseUrl}  auth: ${t.authType}${RESET}`);
            for (const ep of t.endpoints) {
              console.log(`    ${DIM}  ${ep.method} ${ep.path} — ${ep.description}${RESET}`);
            }
          }
          console.log('');
        }
      } catch (err) {
        console.log(`\n  ${RED}Error loading tools: ${(err as Error).message}${RESET}\n`);
      }
      rl.prompt();
      return;
    }

    // ── /cost ─────────────────────────────────────────────────
    if (input === '/cost' || input === '/spend') {
      try {
        const usage = await usageRepo.getTotalSpend(testUserId);
        const breakdown = await usageRepo.getSpendBreakdown({
          userId: testUserId,
          groupBy: 'model',
        });

        console.log('');
        console.log(`  ${BOLD}LLM Spend:${RESET}`);
        console.log(`  ${DIM}Total:${RESET}  $${usage.totalCostUsd.toFixed(4)}`);
        console.log(`  ${DIM}Calls:${RESET}  ${usage.totalCalls}`);
        console.log(`  ${DIM}Tokens:${RESET} ${(usage.totalPromptTokens + usage.totalCompletionTokens).toLocaleString()}`);

        if (breakdown.length > 0) {
          console.log(`\n  ${BOLD}By model:${RESET}`);
          for (const b of breakdown) {
            console.log(`  ${DIM}•${RESET} ${b.groupKey}: $${b.totalCostUsd.toFixed(4)} (${b.callCount} calls)`);
          }
        }
        console.log('');
      } catch (err) {
        console.log(`\n  ${RED}Error loading usage: ${(err as Error).message}${RESET}\n`);
      }
      rl.prompt();
      return;
    }

    // ── Unknown command ───────────────────────────────────────
    if (input.startsWith('/')) {
      console.log(`\n  ${DIM}Unknown command. Try /bots, /new, /switch, /delete, /skills, /tools, /cost, or /quit${RESET}\n`);
      rl.prompt();
      return;
    }

    // ── Chat ──────────────────────────────────────────────────
    try {
      await instrumented.chat(input, bot!.botId as string, testUserId, currentSessionId);
    } catch (err) {
      console.log(`\n  ${RED}Error: ${(err as Error).message}${RESET}\n`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log(`\n  ${DIM}Goodbye!${RESET}\n`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  process.exit(1);
});
