/**
 * Learning Flow — the multi-step orchestration for auto-skill learning.
 *
 * Flow:
 * 1. Search for API docs (Brave Search)
 * 2. Fetch top doc pages (page-fetcher)
 * 3. Analyze docs with LLM (doc-analyzer)
 * 4. Build proposal (proposal-builder)
 * 5. Return proposal for user approval
 *
 * The orchestrator handles credential collection and creation after approval.
 * This function only covers steps 1-5.
 */

import type { LLMGatewayPort } from '../bot-runtime/orchestrator/message-orchestrator.js';
import type {
  LearningFlowInput,
  LearningFlowOutput,
  LearningProgressEntry,
  LearningStage,
} from './types.js';
import { searchForApiDocs } from './brave-search.js';
import { fetchPages } from './page-fetcher.js';
import { analyzeApiDocs } from './doc-analyzer.js';
import { buildLearningProposal } from './proposal-builder.js';
import { WebResearchError } from '../common/errors/index.js';

/**
 * Execute the full learning flow: search -> fetch -> analyze -> propose.
 *
 * Returns a LearningProposal for the orchestrator to present to the user.
 * Throws WebResearchError on irrecoverable failures.
 */
export async function executeLearningFlow(
  llm: LLMGatewayPort,
  input: LearningFlowInput,
): Promise<LearningFlowOutput> {
  const progress: LearningProgressEntry[] = [];

  function log(stage: LearningStage, message: string): void {
    progress.push({ stage, message, timestamp: new Date() });
  }

  // Step 1: Search
  log('searching', `Searching for ${input.serviceName} API documentation...`);
  const searchResponse = await searchForApiDocs(input.serviceName);

  if (searchResponse.results.length === 0) {
    throw new WebResearchError(
      `No documentation found for "${input.serviceName}". Try a more specific name.`,
      'searching',
    );
  }

  // Prioritize API doc URLs, take top 5
  const docUrls = searchResponse.results
    .sort((a, b) => (b.isApiDoc ? 1 : 0) - (a.isApiDoc ? 1 : 0))
    .slice(0, 5)
    .map((r) => r.url);

  // Step 2: Fetch pages
  log('fetching', `Reading ${docUrls.length} documentation pages...`);
  const pages = await fetchPages(docUrls, { maxConcurrent: 3, maxPages: 5 });

  if (pages.length === 0) {
    throw new WebResearchError(
      `Could not read any documentation pages for "${input.serviceName}".`,
      'fetching',
    );
  }

  // Step 3: Analyze with LLM
  log('analyzing', `Analyzing ${input.serviceName} API documentation...`);
  const extractedApi = await analyzeApiDocs(llm, input.serviceName, pages);

  if (extractedApi.endpoints.length === 0) {
    throw new WebResearchError(
      `Could not extract any API endpoints from ${input.serviceName} docs. The documentation might not be in a standard format.`,
      'analyzing',
    );
  }

  // Step 4: Build proposal
  log('proposing', `Building integration proposal for ${input.serviceName}...`);
  const sourceUrls = pages.map((p) => p.url);
  const proposal = await buildLearningProposal(llm, extractedApi, sourceUrls);

  log('complete', `Ready! Found ${extractedApi.endpoints.length} endpoints, proposing ${proposal.skillProposals.length} skills.`);

  return { proposal, progressLog: progress };
}
