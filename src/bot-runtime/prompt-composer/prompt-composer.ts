import type {
  CompositionInput,
  GeneralCompositionInput,
  Prompt,
  ToolDefinition,
  MemoryFact,
  RAGChunk,
  TableSchema,
} from '../../common/types/orchestrator.js';
import type { SoulDefinition } from '../../common/types/soul.js';
import type { ToolRegistryEntry } from '../../common/types/tool-registry.js';

/**
 * PromptComposer — Spec #2 interface implementation.
 *
 * Pure function: takes already-loaded data, returns a formatted prompt.
 * No I/O, no database calls, no LLM calls. This makes it trivially testable.
 *
 * The prompt structure follows the pattern from Spec #2:
 * SYSTEM: bot identity + skill instructions + data context + constraints
 * MESSAGES: conversation history + current message
 * TOOLS: data query/insert/update tools (if skill has data)
 */

export function composeSkillPrompt(input: CompositionInput): Prompt {
  const { skill, message, conversationHistory, memoryContext, ragResults, skillData, tableSchemas, soul } = input;

  const systemParts: string[] = [];

  // Bot identity
  systemParts.push(`You are a personal AI assistant.`);

  // Soul — injected before skill instructions so personality persists during skill execution
  if (soul) {
    systemParts.push(composeSoulSection(soul));
  }

  // Active skill
  systemParts.push(`\nACTIVE SKILL: ${skill.name}`);
  systemParts.push(`SKILL PURPOSE: ${skill.description}`);
  systemParts.push(`\nSKILL INSTRUCTIONS:\n${skill.behaviorPrompt}`);

  // Table schemas (so the LLM can generate valid SQL)
  if (tableSchemas.length > 0) {
    systemParts.push('\nAVAILABLE DATA TABLES:');
    for (const schema of tableSchemas) {
      const colDefs = schema.columns
        .map((c) => `  ${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`)
        .join('\n');
      systemParts.push(`\nTABLE ${schema.tableName}:\n${colDefs}`);
    }
  }

  // Skill data snapshot (recent rows for context)
  if (skillData.rows.length > 0) {
    systemParts.push(`\nCURRENT DATA (${skillData.tableName}, ${skillData.totalCount} total rows):`);
    // Show up to 10 recent rows to avoid prompt bloat
    const previewRows = skillData.rows.slice(0, 10);
    systemParts.push(JSON.stringify(previewRows, null, 2));
    if (skillData.totalCount > 10) {
      systemParts.push(`... and ${skillData.totalCount - 10} more rows. Use query_skill_data to search.`);
    }
  }

  // Memory context
  if (memoryContext.length > 0) {
    systemParts.push('\nUSER CONTEXT:');
    for (const fact of memoryContext) {
      systemParts.push(`- ${fact.key}: ${fact.value}`);
    }
  }

  // RAG results
  if (ragResults.length > 0) {
    systemParts.push('\nRELEVANT KNOWLEDGE:');
    for (const chunk of ragResults) {
      systemParts.push(`[source: ${chunk.documentId}] ${chunk.content}`);
    }
  }

  // Constraints
  systemParts.push('\nCONSTRAINTS:');
  systemParts.push('- Be concise and helpful. Do not include technical details unless asked.');
  systemParts.push('- If you need to query data, use the query_skill_data tool.');
  systemParts.push('- If the user provides new data to store, use insert_skill_data.');
  systemParts.push(`- Format responses as: ${skill.outputFormat}`);
  systemParts.push('- Never fabricate data. If you don\'t have the information, say so.');

  // Build message history
  const messages = conversationHistory.map((msg) => ({
    role: msg.role as 'user' | 'assistant',
    content: msg.content,
  }));
  messages.push({ role: 'user', content: message.content });

  // API integrations (if skill has required integrations with loaded tools)
  if (input.apiTools && input.apiTools.length > 0) {
    systemParts.push('\nAVAILABLE API INTEGRATIONS:');
    for (const tool of input.apiTools) {
      systemParts.push(`\n${tool.name.toUpperCase()} (${tool.baseUrl}):`);
      systemParts.push(`  ${tool.description}`);
      for (const ep of tool.endpoints) {
        systemParts.push(`  - ${ep.method} ${ep.path}: ${ep.description}`);
      }
    }
    systemParts.push('\nUse the call_api tool to make requests. Never fabricate API endpoints.');
  }

  // Tools (if skill has data tables)
  const tools = buildSkillTools(skill.dataTable, skill.readableTables);

  // API tools (if skill has external integrations)
  if (input.apiTools && input.apiTools.length > 0) {
    const apiToolDefs = buildApiTools(input.apiTools);
    tools.push(...apiToolDefs);
  }

  return {
    system: systemParts.join('\n'),
    messages,
    tools,
  };
}

export function composeGeneralPrompt(input: GeneralCompositionInput): Prompt {
  const { message, conversationHistory, memoryContext, botConfig } = input;

  const systemParts: string[] = [];

  systemParts.push(`You are ${botConfig.name}, a personal AI assistant.`);

  if (botConfig.soul) {
    // Structured soul — rich multi-section personality
    systemParts.push(composeSoulSection(botConfig.soul));

    // Still include context if present (business details supplement the soul)
    if (botConfig.context) {
      systemParts.push(`\nCONTEXT: ${botConfig.context}`);
    }
  } else {
    // Fallback: flat personality/context for bots without a soul
    if (botConfig.personality) {
      systemParts.push(`\nPERSONALITY: ${botConfig.personality}`);
    }

    if (botConfig.context) {
      systemParts.push(`\nCONTEXT: ${botConfig.context}`);
    }
  }

  if (memoryContext.length > 0) {
    systemParts.push('\nUSER CONTEXT:');
    for (const fact of memoryContext) {
      systemParts.push(`- ${fact.key}: ${fact.value}`);
    }
  }

  // Capabilities — so the bot knows what it can do
  systemParts.push('\nCAPABILITIES:');
  systemParts.push('- You can learn new API integrations. If a user wants you to interact with an external');
  systemParts.push('  service, tell them to say "Learn how to use [ServiceName]" and you\'ll research the API');
  systemParts.push('  docs and propose new tools and skills.');
  systemParts.push('- You can propose and create new skills for recurring tasks.');
  systemParts.push('- You remember facts from previous conversations and use them as context.');

  // Current skills — so the bot knows what it already has
  if (input.skillSummary && input.skillSummary.length > 0) {
    systemParts.push('\nYOUR CURRENT SKILLS:');
    for (const s of input.skillSummary) {
      systemParts.push(`- ${s.name}: ${s.description}`);
    }
  }

  systemParts.push('\nCONSTRAINTS:');
  systemParts.push('- Be concise, friendly, and helpful.');
  systemParts.push('- If the user asks you to do something you can\'t do yet, suggest creating a new skill');
  systemParts.push('  or learning a new API integration.');
  systemParts.push('- Never fabricate data. If you don\'t have the information, say so.');

  const messages = conversationHistory.map((msg) => ({
    role: msg.role as 'user' | 'assistant',
    content: msg.content,
  }));
  messages.push({ role: 'user', content: message.content });

  return {
    system: systemParts.join('\n'),
    messages,
    tools: [],
  };
}

// ─── Soul Rendering ────────────────────────────────────────────

/**
 * Renders a SoulDefinition into a structured prompt section.
 * Each layer becomes a clearly labeled section that the LLM can follow.
 */
export function composeSoulSection(soul: SoulDefinition): string {
  const parts: string[] = [];

  // 1. Personality Traits
  parts.push('\nPERSONALITY:');
  parts.push(`- Tone: ${soul.personalityTraits.tone}`);
  parts.push(`- Energy: ${soul.personalityTraits.energy}`);
  if (soul.personalityTraits.patterns.length > 0) {
    parts.push(`- Patterns: ${soul.personalityTraits.patterns.join(', ')}`);
  }

  // 2. Values & Principles
  if (soul.values.priorities.length > 0 || soul.values.beliefs.length > 0) {
    parts.push('\nVALUES & PRINCIPLES:');
    for (const p of soul.values.priorities) {
      parts.push(`- ${p}`);
    }
    for (const b of soul.values.beliefs) {
      parts.push(`- ${b}`);
    }
  }

  // 3. Communication Style
  parts.push('\nCOMMUNICATION STYLE:');
  parts.push(`- Verbosity: ${soul.communicationStyle.verbosity} | Formality: ${soul.communicationStyle.formality}`);
  if (soul.communicationStyle.formatting.length > 0) {
    for (const f of soul.communicationStyle.formatting) {
      parts.push(`- ${f}`);
    }
  }

  // 4. Behavioral Rules
  if (soul.behavioralRules.always.length > 0 || soul.behavioralRules.never.length > 0 || soul.behavioralRules.guardrails.length > 0) {
    parts.push('\nBEHAVIORAL RULES:');
    if (soul.behavioralRules.always.length > 0) {
      parts.push(`- ALWAYS: ${soul.behavioralRules.always.join('; ')}`);
    }
    if (soul.behavioralRules.never.length > 0) {
      parts.push(`- NEVER: ${soul.behavioralRules.never.join('; ')}`);
    }
    for (const g of soul.behavioralRules.guardrails) {
      parts.push(`- ${g}`);
    }
  }

  // 5. Decision Framework
  if (soul.decisionFramework.ambiguity || soul.decisionFramework.conflictResolution || soul.decisionFramework.escalation) {
    parts.push('\nDECISION FRAMEWORK:');
    if (soul.decisionFramework.ambiguity) {
      parts.push(`- Ambiguity: ${soul.decisionFramework.ambiguity}`);
    }
    if (soul.decisionFramework.conflictResolution) {
      parts.push(`- Conflicts: ${soul.decisionFramework.conflictResolution}`);
    }
    if (soul.decisionFramework.escalation) {
      parts.push(`- Escalation: ${soul.decisionFramework.escalation}`);
    }
  }

  return parts.join('\n');
}

// ─── Tool Definitions ──────────────────────────────────────────

function buildSkillTools(
  dataTable: string | null,
  readableTables: string[],
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // All data-bearing skills can read
  const allTables = dataTable ? [dataTable, ...readableTables] : readableTables;
  if (allTables.length > 0) {
    tools.push({
      name: 'query_skill_data',
      description: `Execute a SELECT query on the skill's data tables. Available tables: ${allTables.join(', ')}`,
      parameters: {
        type: 'object',
        properties: {
          sql: {
            type: 'string',
            description: 'A SELECT SQL query to execute',
          },
        },
        required: ['sql'],
      },
    });
  }

  // Only the skill's own table supports writes
  if (dataTable) {
    tools.push({
      name: 'insert_skill_data',
      description: `Insert a new row into the ${dataTable} table`,
      parameters: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            description: 'Key-value pairs for the new row',
          },
        },
        required: ['data'],
      },
    });

    tools.push({
      name: 'update_skill_data',
      description: `Update an existing row in the ${dataTable} table`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Row UUID to update' },
          data: { type: 'object', description: 'Fields to update' },
        },
        required: ['id', 'data'],
      },
    });
  }

  tools.push({
    name: 'schedule_notification',
    description: 'Schedule a push notification to send to the user',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Notification message' },
        at: { type: 'string', description: 'ISO datetime for when to send' },
        recurring: { type: 'string', description: 'Cron expression for recurring notifications, or null for one-time' },
      },
      required: ['message', 'at'],
    },
  });

  return tools;
}

// ─── API Tool Definitions ─────────────────────────────────────

/**
 * Generates a `call_api` tool definition for the LLM based on registered tool integrations.
 * The endpoint catalog is embedded in the tool description so the LLM knows what's available.
 */
export function buildApiTools(tools: ToolRegistryEntry[]): ToolDefinition[] {
  if (tools.length === 0) return [];

  // Build endpoint catalog for the tool description
  const endpointCatalog: string[] = [];
  for (const tool of tools) {
    for (const ep of tool.endpoints) {
      endpointCatalog.push(`- ${tool.name}: ${ep.method} ${ep.path} — ${ep.description}`);
    }
  }

  const toolNames = [...new Set(tools.map((t) => t.name))];
  const allMethods = [...new Set(tools.flatMap((t) => t.endpoints.map((e) => e.method)))];

  return [{
    name: 'call_api',
    description: [
      'Call an external API using a registered tool integration.',
      'Available endpoints:',
      ...endpointCatalog,
      '',
      'IMPORTANT: Only call endpoints listed above. Include required parameters in the body.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          enum: toolNames,
          description: 'Name of the registered tool',
        },
        endpoint: {
          type: 'string',
          description: 'API endpoint path (e.g. /v1/designs)',
        },
        method: {
          type: 'string',
          enum: allMethods,
          description: 'HTTP method',
        },
        body: {
          type: 'object',
          description: 'Request body (for POST/PUT/PATCH)',
        },
      },
      required: ['tool', 'endpoint', 'method'],
    },
  }];
}
