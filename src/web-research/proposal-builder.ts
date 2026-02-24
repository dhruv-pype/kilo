/**
 * Proposal Builder — transforms ExtractedApiInfo into a LearningProposal
 * with concrete tool and skill proposals ready for user approval.
 *
 * Uses the LLM to generate appropriate skill definitions (behavior prompts,
 * trigger patterns) based on the extracted endpoints.
 */

import type { LLMGatewayPort } from '../bot-runtime/orchestrator/message-orchestrator.js';
import type {
  ExtractedApiInfo,
  LearningProposal,
  ToolProposal,
  SkillProposalFromLearning,
} from './types.js';
import type { ToolEndpoint } from '../common/types/tool-registry.js';
import type { Prompt, LLMResponse } from '../common/types/orchestrator.js';
import { WebResearchError } from '../common/errors/index.js';

/**
 * Build a LearningProposal from extracted API info.
 * Groups endpoints into logical skills (e.g., "Create Design", "Export Design").
 */
export async function buildLearningProposal(
  llm: LLMGatewayPort,
  extractedApi: ExtractedApiInfo,
  sourceUrls: string[],
): Promise<LearningProposal> {
  const toolProposal = buildToolProposal(extractedApi);
  const skillProposals = await generateSkillProposals(llm, extractedApi, toolProposal.name);

  return {
    serviceName: extractedApi.serviceName,
    toolProposal,
    skillProposals,
    authInstructions: extractedApi.authInstructions,
    sourceUrls,
    confidence: extractedApi.confidence,
  };
}

/**
 * Build ToolProposal from extracted API info (pure function, no LLM).
 */
export function buildToolProposal(api: ExtractedApiInfo): ToolProposal {
  const name = api.serviceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

  const endpoints: ToolEndpoint[] = api.endpoints.map((ep) => ({
    path: ep.path,
    method: ep.method.toUpperCase() as ToolEndpoint['method'],
    description: ep.description,
    parameters: ep.parameters,
    responseSchema: ep.responseSchema ?? null,
  }));

  return {
    name,
    description: `${api.serviceName} API integration`,
    baseUrl: api.baseUrl,
    authType: api.authType,
    endpoints,
  };
}

/**
 * Use LLM to generate skill proposals from endpoints.
 * Groups related endpoints into logical skills.
 */
async function generateSkillProposals(
  llm: LLMGatewayPort,
  api: ExtractedApiInfo,
  toolName: string,
): Promise<SkillProposalFromLearning[]> {
  const prompt = composeSkillGenerationPrompt(api, toolName);

  let response: LLMResponse;
  try {
    response = await llm.complete(prompt, {
      taskType: 'skill_generation',
      streaming: false,
    });
  } catch (err) {
    throw new WebResearchError(
      `LLM call failed during skill generation: ${(err as Error).message}`,
      'proposing',
      err,
    );
  }

  return parseSkillProposals(response, toolName);
}

/**
 * Compose the prompt for skill generation from endpoints.
 */
function composeSkillGenerationPrompt(api: ExtractedApiInfo, toolName: string): Prompt {
  const endpointList = api.endpoints
    .map((ep) => `- ${ep.method} ${ep.path}: ${ep.description}`)
    .join('\n');

  const system = `You are a skill designer for an AI assistant platform. Given a set of API endpoints, your job is to group them into user-facing "skills" — natural-language capabilities that the assistant can perform.

Each skill should:
- Have a clear, concise name (e.g., "Create Design", "Send Message")
- Have a description of what it does
- Have 3-5 trigger patterns — natural language phrases a user might say
- Have a behavior prompt — instructions for the AI on how to use the endpoints
- Reference the tool name "${toolName}" in requiredIntegrations

Group related endpoints into 1-5 skills. Each endpoint should belong to at least one skill.

You MUST use the output_skills tool to provide your answer.`;

  return {
    system,
    messages: [
      {
        role: 'user',
        content: `Here are the ${api.serviceName} API endpoints:\n\n${endpointList}\n\nCreate skill proposals using the output_skills tool.`,
      },
    ],
    tools: [
      {
        name: 'output_skills',
        description: 'Output the proposed skills',
        parameters: {
          type: 'object',
          required: ['skills'],
          properties: {
            skills: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'description', 'triggerPatterns', 'behaviorPrompt'],
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  triggerPatterns: { type: 'array', items: { type: 'string' } },
                  behaviorPrompt: { type: 'string' },
                  outputFormat: { type: 'string', enum: ['text', 'structured_card'] },
                },
              },
            },
          },
        },
      },
    ],
  };
}

/**
 * Parse skill proposals from LLM response.
 */
function parseSkillProposals(response: LLMResponse, toolName: string): SkillProposalFromLearning[] {
  // Try tool call first
  const toolCall = response.toolCalls.find((tc) => tc.toolName === 'output_skills');
  let rawSkills: Array<Record<string, unknown>> | undefined;

  if (toolCall) {
    const args = toolCall.arguments as Record<string, unknown>;
    rawSkills = args.skills as Array<Record<string, unknown>>;
  }

  // Fallback: try JSON from content
  if (!rawSkills) {
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        rawSkills = (parsed.skills ?? parsed) as Array<Record<string, unknown>>;
      }
    } catch {
      // JSON parse failed
    }
  }

  if (!rawSkills || !Array.isArray(rawSkills) || rawSkills.length === 0) {
    throw new WebResearchError(
      'LLM did not produce valid skill proposals.',
      'proposing',
    );
  }

  return rawSkills.map((skill) => ({
    name: (skill.name as string) || 'Unnamed Skill',
    description: (skill.description as string) || '',
    triggerPatterns: Array.isArray(skill.triggerPatterns) ? (skill.triggerPatterns as string[]) : [],
    behaviorPrompt: (skill.behaviorPrompt as string) || '',
    requiredIntegrations: [toolName],
    outputFormat: ((skill.outputFormat as string) === 'structured_card' ? 'structured_card' : 'text') as 'text' | 'structured_card',
  }));
}
