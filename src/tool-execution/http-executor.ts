/**
 * HTTP Executor — sandboxed HTTP client for external API calls.
 *
 * Security constraints:
 * - HTTPS only (no HTTP)
 * - SSRF prevention: blocks localhost, loopback, private IP ranges
 * - Response body capped at 512KB
 * - Configurable timeout (default 10s)
 * - Uses native fetch (Node 20+ required)
 */

import { ToolExecutionError } from '../common/errors/index.js';
import type { HttpToolRequest, HttpToolResponse } from '../common/types/tool-registry.js';

const MAX_RESPONSE_BYTES = 512 * 1024;  // 512KB
const DEFAULT_TIMEOUT_MS = 10_000;

export async function executeHttpTool(request: HttpToolRequest): Promise<HttpToolResponse> {
  // 1. Validate URL is HTTPS
  const url = new URL(request.url);
  if (url.protocol !== 'https:') {
    throw new ToolExecutionError(
      `Only HTTPS URLs are allowed. Got: ${url.protocol}`,
      'http-executor',
    );
  }

  // 2. Block private/loopback addresses (SSRF prevention)
  const hostname = url.hostname;
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' || hostname === '[::1]' ||
    hostname.endsWith('.local') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw new ToolExecutionError(
      `Requests to private/loopback addresses are not allowed: ${hostname}`,
      'http-executor',
    );
  }

  // 3. Build fetch options
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    request.timeoutMs || DEFAULT_TIMEOUT_MS,
  );

  const headers: Record<string, string> = { ...request.headers, 'User-Agent': 'Kilo/1.0' };

  const fetchOptions: RequestInit = {
    method: request.method,
    headers,
    signal: controller.signal,
  };

  if (request.body && request.method !== 'GET') {
    fetchOptions.body = typeof request.body === 'string'
      ? request.body
      : JSON.stringify(request.body);
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  try {
    const res = await fetch(request.url, fetchOptions);

    // 4. Read response with size cap
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let truncated = false;

    if (reader) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          truncated = true;
          const overflow = totalBytes - MAX_RESPONSE_BYTES;
          chunks.push(value.slice(0, value.byteLength - overflow));
          reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }

    const bodyText = new TextDecoder().decode(
      concatUint8Arrays(chunks),
    );

    // 5. Parse body as JSON if possible
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      parsedBody = bodyText;
    }

    // 6. Map response headers
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      status: res.status,
      headers: responseHeaders,
      body: parsedBody,
      truncated,
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ToolExecutionError(
        `Request timed out after ${request.timeoutMs || DEFAULT_TIMEOUT_MS}ms`,
        'http-executor',
      );
    }
    throw new ToolExecutionError(
      `HTTP request failed: ${(err as Error).message}`,
      'http-executor',
      err,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Concatenate Uint8Array chunks without Buffer.concat (works in all runtimes) */
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
