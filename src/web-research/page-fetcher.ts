/**
 * Page Fetcher — fetches web pages and extracts structured text.
 *
 * Uses native fetch() for HTTPS requests and node-html-parser for parsing.
 * Reuses the same security constraints as http-executor.ts:
 * - HTTPS only
 * - SSRF prevention (block private IPs)
 * - Response body capped (1MB for HTML)
 * - Configurable timeout
 */

import { parse as parseHTML } from 'node-html-parser';
import type { FetchedPage } from './types.js';
import { WebResearchError } from '../common/errors/index.js';

const MAX_HTML_BYTES = 1_024 * 1_024;  // 1MB
const MAX_TEXT_LENGTH = 50_000;         // chars
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch a web page, parse HTML, extract text content and code blocks.
 */
export async function fetchPage(url: string): Promise<FetchedPage> {
  validateUrl(url);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Kilo/1.0 (Bot Learning)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new WebResearchError(
        `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
        'fetching',
      );
    }

    // Read response with size cap
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_HTML_BYTES) {
          chunks.push(value.slice(0, value.byteLength - (totalBytes - MAX_HTML_BYTES)));
          reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }

    const htmlText = new TextDecoder().decode(concatUint8Arrays(chunks));
    const root = parseHTML(htmlText);

    // Remove noise elements
    for (const tag of ['script', 'style', 'nav', 'footer', 'header', 'noscript', 'svg']) {
      root.querySelectorAll(tag).forEach((el) => el.remove());
    }

    // Extract title
    const title = root.querySelector('title')?.textContent?.trim()
      ?? root.querySelector('h1')?.textContent?.trim()
      ?? '';

    // Extract code blocks before stripping them
    const codeBlocks = extractCodeBlocks(root);

    // Extract text content
    let textContent = root.textContent
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim();

    // Truncate if needed
    const truncated = textContent.length > MAX_TEXT_LENGTH;
    if (truncated) {
      textContent = textContent.slice(0, MAX_TEXT_LENGTH);
    }

    return {
      url,
      title,
      textContent,
      codeBlocks,
      truncated,
      fetchedAt: new Date(),
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new WebResearchError(`Page fetch timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`, 'fetching');
    }
    if (err instanceof WebResearchError) throw err;
    throw new WebResearchError(`Failed to fetch page: ${(err as Error).message}`, 'fetching', err);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch multiple pages in parallel with concurrency limit.
 * Skips pages that fail (logs warning, continues).
 */
export async function fetchPages(
  urls: string[],
  options?: { maxConcurrent?: number; maxPages?: number },
): Promise<FetchedPage[]> {
  const maxPages = options?.maxPages ?? 5;
  const maxConcurrent = options?.maxConcurrent ?? 3;
  const targetUrls = urls.slice(0, maxPages);

  const results: FetchedPage[] = [];
  const queue = [...targetUrls];
  const inFlight: Promise<void>[] = [];

  while (queue.length > 0 || inFlight.length > 0) {
    // Launch up to maxConcurrent
    while (queue.length > 0 && inFlight.length < maxConcurrent) {
      const url = queue.shift()!;
      const promise = fetchPage(url)
        .then((page) => {
          results.push(page);
        })
        .catch(() => {
          // Skip failed pages silently
        })
        .finally(() => {
          const idx = inFlight.indexOf(promise);
          if (idx !== -1) inFlight.splice(idx, 1);
        });
      inFlight.push(promise);
    }

    // Wait for at least one to complete
    if (inFlight.length > 0) {
      await Promise.race(inFlight);
    }
  }

  return results;
}

/**
 * Validate URL is safe to fetch (HTTPS, no private IPs).
 * Same logic as http-executor.ts.
 */
function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebResearchError(`Invalid URL: ${url}`, 'fetching');
  }

  if (parsed.protocol !== 'https:') {
    throw new WebResearchError(`Only HTTPS URLs are allowed. Got: ${parsed.protocol}`, 'fetching');
  }

  const hostname = parsed.hostname;
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' || hostname === '[::1]' ||
    hostname.endsWith('.local') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw new WebResearchError(
      `Requests to private/loopback addresses are not allowed: ${hostname}`,
      'fetching',
    );
  }
}

/**
 * Extract code blocks from <pre> and <code> elements.
 */
function extractCodeBlocks(root: ReturnType<typeof parseHTML>): string[] {
  const blocks: string[] = [];

  // Get <pre> blocks (often contain full code examples)
  root.querySelectorAll('pre').forEach((el) => {
    const text = el.textContent.trim();
    if (text.length > 10) {
      blocks.push(text);
    }
  });

  // Get standalone <code> blocks that aren't inside <pre>
  root.querySelectorAll('code').forEach((el) => {
    if (el.parentNode?.rawTagName === 'pre') return; // already captured
    const text = el.textContent.trim();
    if (text.length > 20 && text.includes(' ')) {
      blocks.push(text);
    }
  });

  return blocks;
}

/** Concatenate Uint8Array chunks */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.byteLength;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.byteLength;
  }
  return result;
}
