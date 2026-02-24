/**
 * Doc Analyzer — uses the LLM to extract structured API information
 * from fetched documentation pages.
 *
 * This is the "reading comprehension" step: given raw docs text,
 * produce a structured ExtractedApiInfo with endpoints, auth, etc.
 *
 * Uses the LLMGatewayPort interface so it stays testable with mocks.
 */

import type { LLMGatewayPort } from '../bot-runtime/orchestrator/message-orchestrator.js';
import type { FetchedPage, ExtractedApiInfo } from './types.js';
import type { Prompt, LLMResponse } from '../common/types/orchestrator.js';
import { WebResearchError } from '../common/errors/index.js';

const MAX_DOC_CONTEXT_CHARS = 30_000;

/**
 * Analyze fetched pages to extract API information.
 * Calls the LLM with a structured extraction prompt.
 */
export async function analyzeApiDocs(
  llm: LLMGatewayPort,
  serviceName: string,
  pages: FetchedPage[],
): Promise<ExtractedApiInfo> {
  // Build the combined doc context
  const docsContext = buildDocsContext(pages);
  const codeBlocks = pages.flatMap((p) => p.codeBlocks).slice(0, 20);

  // Compose the extraction prompt
  const prompt = composeLearningExtractionPrompt(serviceName, docsContext, codeBlocks);

  // Call LLM
  let response: LLMResponse;
  try {
    response = await llm.complete(prompt, {
      taskType: 'doc_extraction',
      streaming: false,
    });
  } catch (err) {
    throw new WebResearchError(
      `LLM call failed during doc analysis: ${(err as Error).message}`,
      'analyzing',
      err,
    );
  }

  // Parse the response
  return parseExtractionOutput(response, serviceName);
}

/**
 * Build a combined docs context from fetched pages.
 * Prioritizes pages and respects MAX_DOC_CONTEXT_CHARS.
 */
function buildDocsContext(pages: FetchedPage[]): string {
  const sections: string[] = [];
  let totalChars = 0;

  for (const page of pages) {
    const section = `--- ${page.title} (${page.url}) ---\n${page.textContent}`;
    if (totalChars + section.length > MAX_DOC_CONTEXT_CHARS) {
      const remaining = MAX_DOC_CONTEXT_CHARS - totalChars;
      if (remaining > 200) {
        sections.push(section.slice(0, remaining) + '\n[truncated]');
      }
      break;
    }
    sections.push(section);
    totalChars += section.length;
  }

  return sections.join('\n\n');
}

/**
 * Compose the prompt for API doc extraction.
 */
export function composeLearningExtractionPrompt(
  serviceName: string,
  docsContext: string,
  codeBlocks: string[],
): Prompt {
  const codeSection = codeBlocks.length > 0
    ? `\n\nCODE EXAMPLES FROM DOCUMENTATION:\n${codeBlocks.slice(0, 10).join('\n---\n')}`
    : '';

  const system = `You are an API documentation analyst. Your job is to read API documentation and extract structured information about the API.

Given documentation for the "${serviceName}" API, extract:
1. The base URL for API requests
2. The authentication type (api_key, bearer, oauth2, or custom_header)
3. Human-readable instructions for obtaining credentials
4. A list of the most useful API endpoints (up to 10)
5. Rate limit information if mentioned
6. Your confidence level (0-1) based on how much info you found

For each endpoint, extract:
- HTTP method (GET, POST, PUT, PATCH, DELETE)
- Path (relative to base URL, e.g., /v1/designs)
- Description of what it does
- Parameters as JSON Schema (at minimum: type and properties)
- Response schema if documented (or null)

You MUST use the output_api_info tool to provide your answer in structured form.
If you cannot find enough information, still use the tool but set confidence to a low value.`;

  return {
    system,
    messages: [
      {
        role: 'user',
        content: `Here is the documentation for ${serviceName}:\n\n${docsContext}${codeSection}\n\nExtract the API information using the output_api_info tool.`,
      },
    ],
    tools: [
      {
        name: 'output_api_info',
        description: 'Output the extracted API information in structured form',
        parameters: {
          type: 'object',
          required: ['serviceName', 'baseUrl', 'authType', 'authInstructions', 'endpoints', 'confidence'],
          properties: {
            serviceName: { type: 'string', description: 'Name of the service' },
            baseUrl: { type: 'string', description: 'Base URL for API requests' },
            authType: { type: 'string', enum: ['api_key', 'bearer', 'oauth2', 'custom_header'] },
            authInstructions: { type: 'string', description: 'How to obtain credentials' },
            endpoints: {
              type: 'array',
              items: {
                type: 'object',
                required: ['path', 'method', 'description', 'parameters'],
                properties: {
                  path: { type: 'string' },
                  method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                  description: { type: 'string' },
                  parameters: { type: 'object' },
                  responseSchema: { type: ['object', 'null'] },
                },
              },
            },
            rateLimits: { type: ['string', 'null'], description: 'Rate limit info if mentioned' },
            confidence: { type: 'number', description: 'Confidence level 0-1' },
          },
        },
      },
    ],
  };
}

/**
 * Parse and validate the LLM's extraction output.
 */
function parseExtractionOutput(response: LLMResponse, serviceName: string): ExtractedApiInfo {
  // Try tool call first (preferred)
  const toolCall = response.toolCalls.find((tc) => tc.toolName === 'output_api_info');
  if (toolCall) {
    return validateExtractedInfo(toolCall.arguments as Record<string, unknown>, serviceName);
  }

  // Fallback: try to parse JSON from content
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      return validateExtractedInfo(parsed, serviceName);
    }
  } catch {
    // JSON parse failed
  }

  throw new WebResearchError(
    'LLM did not produce parseable API extraction output. The documentation may not contain clear API information.',
    'analyzing',
  );
}

/**
 * Validate and normalize the extracted info.
 */
function validateExtractedInfo(
  data: Record<string, unknown>,
  fallbackServiceName: string,
): ExtractedApiInfo {
  const baseUrl = data.baseUrl as string;
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new WebResearchError('Extracted API info missing base URL', 'analyzing');
  }

  const endpoints = data.endpoints as Array<Record<string, unknown>>;
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new WebResearchError('Extracted API info has no endpoints', 'analyzing');
  }

  return {
    serviceName: (data.serviceName as string) || fallbackServiceName,
    baseUrl: baseUrl.replace(/\/$/, ''), // strip trailing slash
    authType: validateAuthType(data.authType as string) || 'bearer',
    authInstructions: (data.authInstructions as string) || `Obtain credentials from the ${fallbackServiceName} developer portal.`,
    endpoints: endpoints.map((ep) => ({
      path: (ep.path as string) || '/',
      method: ((ep.method as string) || 'GET').toUpperCase(),
      description: (ep.description as string) || '',
      parameters: (ep.parameters as Record<string, unknown>) || {},
      responseSchema: (ep.responseSchema as Record<string, unknown>) || null,
    })),
    rateLimits: (data.rateLimits as string) || null,
    confidence: typeof data.confidence === 'number' ? Math.min(1, Math.max(0, data.confidence)) : 0.5,
  };
}

function validateAuthType(raw: string): 'api_key' | 'bearer' | 'oauth2' | 'custom_header' | null {
  const valid = ['api_key', 'bearer', 'oauth2', 'custom_header'] as const;
  return valid.includes(raw as typeof valid[number]) ? (raw as typeof valid[number]) : null;
}
