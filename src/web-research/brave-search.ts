/**
 * Brave Search client — uses the Brave Web Search API.
 *
 * BRAVE_SEARCH_API_KEY must be set in environment.
 * All requests go to https://api.search.brave.com/res/v1/web/search
 * over HTTPS. Results are filtered to prioritize API documentation.
 */

import type { WebSearchResult, WebSearchResponse } from './types.js';
import { WebResearchError } from '../common/errors/index.js';

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_RESULT_COUNT = 10;
const TIMEOUT_MS = 8_000;

/**
 * Search the web for API documentation using Brave Search.
 * Appends "API documentation" to the query to focus results.
 */
export async function searchForApiDocs(
  serviceName: string,
  options?: { count?: number },
): Promise<WebSearchResponse> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new WebResearchError(
      'Web research is not configured. Set BRAVE_SEARCH_API_KEY in your environment.',
      'searching',
    );
  }

  const query = `${serviceName} API documentation endpoints reference`;
  const count = options?.count ?? DEFAULT_RESULT_COUNT;

  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new WebResearchError(
        `Brave Search API returned ${response.status}: ${response.statusText}`,
        'searching',
      );
    }

    const data = await response.json() as BraveSearchApiResponse;

    const results: WebSearchResult[] = (data.web?.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description ?? '',
      isApiDoc: scoreAsApiDoc(r.url ?? '', r.title ?? '', r.description ?? ''),
    }));

    return { results, query };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new WebResearchError(
        `Brave Search timed out after ${TIMEOUT_MS}ms`,
        'searching',
      );
    }
    if (err instanceof WebResearchError) throw err;
    throw new WebResearchError(
      `Search failed: ${(err as Error).message}`,
      'searching',
      err,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Heuristic: does this URL look like API documentation?
 */
function scoreAsApiDoc(url: string, title: string, snippet: string): boolean {
  const combined = `${url} ${title} ${snippet}`.toLowerCase();
  const apiPatterns = [
    '/api', '/docs', '/developer', '/reference', '/v1', '/v2',
    'developer.', 'api.', 'docs.',
    'api documentation', 'api reference', 'rest api', 'endpoint',
    'authentication', 'api key', 'developer portal', 'sdk',
  ];
  return apiPatterns.some((pattern) => combined.includes(pattern));
}

// ─── Brave Search API Response Shape ─────────────────────────────

interface BraveSearchApiResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
}
