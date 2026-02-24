import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchForApiDocs } from '../../../src/web-research/brave-search.js';

describe('searchForApiDocs', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiKey = process.env.BRAVE_SEARCH_API_KEY;
    process.env.BRAVE_SEARCH_API_KEY = 'test-brave-key-123';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = originalApiKey;
    }
  });

  it('throws WebResearchError when API key is missing', async () => {
    delete process.env.BRAVE_SEARCH_API_KEY;
    await expect(searchForApiDocs('Canva')).rejects.toThrow('Web research is not configured');
  });

  it('builds correct query URL with service name', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await searchForApiDocs('Canva');

    expect(capturedUrl).toContain('api.search.brave.com');
    expect(capturedUrl).toContain('q=Canva');
    expect(capturedUrl).toContain('API+documentation');
    expect(capturedUrl).toContain('count=10');
  });

  it('sends API key as X-Subscription-Token header', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(
        Object.entries(init?.headers ?? {}),
      );
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await searchForApiDocs('Stripe');

    expect(capturedHeaders['X-Subscription-Token']).toBe('test-brave-key-123');
  });

  it('parses Brave API response and maps results', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({
        web: {
          results: [
            {
              title: 'Canva Developer Platform',
              url: 'https://developers.canva.com/docs/api/reference',
              description: 'REST API documentation for Canva',
            },
            {
              title: 'Canva Blog',
              url: 'https://www.canva.com/blog/design-tips',
              description: 'Design tips and tricks',
            },
          ],
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const response = await searchForApiDocs('Canva');

    expect(response.results).toHaveLength(2);
    expect(response.results[0].title).toBe('Canva Developer Platform');
    expect(response.results[0].url).toBe('https://developers.canva.com/docs/api/reference');
    expect(response.results[0].snippet).toBe('REST API documentation for Canva');
    expect(response.results[0].isApiDoc).toBe(true);  // matches /docs/, /api/, /reference/
    expect(response.results[1].isApiDoc).toBe(false);  // blog post
    expect(response.query).toContain('Canva');
  });

  it('scores isApiDoc correctly for various URL patterns', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({
        web: {
          results: [
            { title: 'API Ref', url: 'https://api.stripe.com/v1/charges', description: 'Create a charge' },
            { title: 'Dev Docs', url: 'https://developer.notion.com/docs', description: 'Getting started' },
            { title: 'Recipe Blog', url: 'https://www.example.com/recipes', description: 'Cake recipes' },
            { title: 'Auth Guide', url: 'https://example.com/guide', description: 'API key authentication' },
          ],
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const response = await searchForApiDocs('Stripe');

    expect(response.results[0].isApiDoc).toBe(true);  // /v1/ in URL
    expect(response.results[1].isApiDoc).toBe(true);  // /developer/ and /docs/ in URL
    expect(response.results[2].isApiDoc).toBe(false);  // no API patterns
    expect(response.results[3].isApiDoc).toBe(true);  // "API key" in snippet
  });

  it('handles empty results', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const response = await searchForApiDocs('NonexistentService');
    expect(response.results).toHaveLength(0);
  });

  it('handles missing web field in response', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const response = await searchForApiDocs('Canva');
    expect(response.results).toHaveLength(0);
  });

  it('throws on non-200 status', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response('Rate limited', { status: 429, statusText: 'Too Many Requests' });
    });

    await expect(searchForApiDocs('Canva')).rejects.toThrow('429');
  });

  it('throws on network error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Network unreachable');
    });

    await expect(searchForApiDocs('Canva')).rejects.toThrow('Network unreachable');
  });

  it('respects custom count parameter', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await searchForApiDocs('Canva', { count: 5 });
    expect(capturedUrl).toContain('count=5');
  });
});
