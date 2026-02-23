import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeHttpTool } from '@/tool-execution/http-executor.js';
import { ToolExecutionError } from '@common/errors/index.js';
import type { HttpToolRequest } from '@common/types/tool-registry.js';

function makeRequest(overrides: Partial<HttpToolRequest> = {}): HttpToolRequest {
  return {
    url: 'https://api.example.com/v1/resource',
    method: 'GET',
    headers: {},
    body: null,
    timeoutMs: 10_000,
    ...overrides,
  };
}

describe('http-executor', () => {
  // ── URL validation ──────────────────────────────────────────

  describe('HTTPS enforcement', () => {
    it('rejects HTTP URLs', async () => {
      await expect(
        executeHttpTool(makeRequest({ url: 'http://api.example.com/v1/resource' })),
      ).rejects.toThrow('Only HTTPS URLs are allowed');
    });

    it('rejects non-HTTP protocols', async () => {
      await expect(
        executeHttpTool(makeRequest({ url: 'ftp://files.example.com/data' })),
      ).rejects.toThrow(ToolExecutionError);
    });
  });

  // ── SSRF prevention ─────────────────────────────────────────

  describe('SSRF prevention', () => {
    const ssrfCases: [string, string][] = [
      ['localhost', 'https://localhost/api'],
      ['127.0.0.1', 'https://127.0.0.1/api'],
      ['[::1]', 'https://[::1]/api'],
      ['something.local', 'https://something.local/api'],
      ['10.0.0.1', 'https://10.0.0.1/api'],
      ['10.255.255.255', 'https://10.255.255.255/api'],
      ['192.168.0.1', 'https://192.168.0.1/api'],
      ['192.168.100.50', 'https://192.168.100.50/api'],
      ['172.16.0.1', 'https://172.16.0.1/api'],
      ['172.31.255.255', 'https://172.31.255.255/api'],
    ];

    for (const [label, url] of ssrfCases) {
      it(`blocks ${label}`, async () => {
        await expect(
          executeHttpTool(makeRequest({ url })),
        ).rejects.toThrow('private/loopback');
      });
    }
  });

  // ── Timeout ─────────────────────────────────────────────────

  describe('timeout', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('throws on timeout with correct message', async () => {
      // Mock fetch that respects the abort signal
      globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        }),
      ) as unknown as typeof fetch;

      await expect(
        executeHttpTool(makeRequest({ timeoutMs: 50 })),
      ).rejects.toThrow('timed out');
    });
  });

  // ── Successful request ──────────────────────────────────────

  describe('successful requests', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns parsed JSON body', async () => {
      const mockBody = { id: 1, name: 'test' };
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(mockBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      ) as unknown as typeof fetch;

      const result = await executeHttpTool(makeRequest());
      expect(result.status).toBe(200);
      expect(result.body).toEqual(mockBody);
      expect(result.truncated).toBe(false);
    });

    it('returns string body when not JSON', async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response('plain text response', { status: 200 })),
      ) as unknown as typeof fetch;

      const result = await executeHttpTool(makeRequest());
      expect(result.body).toBe('plain text response');
    });

    it('includes response headers', async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response('ok', {
          status: 200,
          headers: { 'X-Request-Id': 'abc-123' },
        })),
      ) as unknown as typeof fetch;

      const result = await executeHttpTool(makeRequest());
      expect(result.headers['x-request-id']).toBe('abc-123');
    });

    it('sends body for POST requests', async () => {
      let capturedOptions: RequestInit | undefined;
      globalThis.fetch = vi.fn((_url: string | URL | Request, options?: RequestInit) => {
        capturedOptions = options;
        return Promise.resolve(new Response('{"ok":true}', { status: 201 }));
      }) as unknown as typeof fetch;

      await executeHttpTool(makeRequest({
        method: 'POST',
        body: { name: 'test' },
      }));

      expect(capturedOptions?.method).toBe('POST');
      expect(capturedOptions?.body).toBe('{"name":"test"}');
    });

    it('adds Content-Type: application/json for JSON body', async () => {
      let capturedHeaders: Record<string, string> = {};
      globalThis.fetch = vi.fn((_url: string | URL | Request, options?: RequestInit) => {
        capturedHeaders = options?.headers as Record<string, string>;
        return Promise.resolve(new Response('ok', { status: 200 }));
      }) as unknown as typeof fetch;

      await executeHttpTool(makeRequest({
        method: 'POST',
        body: { name: 'test' },
      }));

      expect(capturedHeaders['Content-Type']).toBe('application/json');
    });

    it('adds User-Agent header', async () => {
      let capturedHeaders: Record<string, string> = {};
      globalThis.fetch = vi.fn((_url: string | URL | Request, options?: RequestInit) => {
        capturedHeaders = options?.headers as Record<string, string>;
        return Promise.resolve(new Response('ok', { status: 200 }));
      }) as unknown as typeof fetch;

      await executeHttpTool(makeRequest());

      expect(capturedHeaders['User-Agent']).toBe('Kilo/1.0');
    });
  });

  // ── Response size cap ──────────────────────────────────────

  describe('response size cap', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('truncates response body exceeding 512KB', async () => {
      // Generate a response body larger than 512KB
      const largeBody = 'x'.repeat(600 * 1024); // 600KB
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response(largeBody, { status: 200 })),
      ) as unknown as typeof fetch;

      const result = await executeHttpTool(makeRequest());
      expect(result.truncated).toBe(true);
      // The body should be a string since it can't be parsed as JSON
      expect(typeof result.body).toBe('string');
      expect((result.body as string).length).toBeLessThanOrEqual(512 * 1024);
    });

    it('does not truncate responses under 512KB', async () => {
      const smallBody = 'x'.repeat(100);
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response(smallBody, { status: 200 })),
      ) as unknown as typeof fetch;

      const result = await executeHttpTool(makeRequest());
      expect(result.truncated).toBe(false);
      expect(result.body).toBe(smallBody);
    });
  });
});
