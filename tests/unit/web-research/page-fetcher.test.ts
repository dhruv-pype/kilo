import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchPage, fetchPages } from '../../../src/web-research/page-fetcher.js';

describe('fetchPage', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchWithHtml(html: string, status = 200): void {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(html);
    globalThis.fetch = vi.fn(async () => {
      return new Response(bytes, {
        status,
        headers: { 'Content-Type': 'text/html' },
      });
    });
  }

  // ── Security ──────────────────────────────────────────────────

  it('rejects non-HTTPS URLs', async () => {
    await expect(fetchPage('http://example.com')).rejects.toThrow('Only HTTPS URLs are allowed');
  });

  it('blocks localhost', async () => {
    await expect(fetchPage('https://localhost/api')).rejects.toThrow('private/loopback');
  });

  it('blocks 127.0.0.1', async () => {
    await expect(fetchPage('https://127.0.0.1/api')).rejects.toThrow('private/loopback');
  });

  it('blocks private IP 10.x.x.x', async () => {
    await expect(fetchPage('https://10.0.0.1/api')).rejects.toThrow('private/loopback');
  });

  it('blocks private IP 192.168.x.x', async () => {
    await expect(fetchPage('https://192.168.1.1/api')).rejects.toThrow('private/loopback');
  });

  it('blocks .local domains', async () => {
    await expect(fetchPage('https://myserver.local/api')).rejects.toThrow('private/loopback');
  });

  it('rejects invalid URLs', async () => {
    await expect(fetchPage('not-a-url')).rejects.toThrow('Invalid URL');
  });

  // ── HTML Parsing ─────────────────────────────────────────────

  it('extracts title from <title> tag', async () => {
    mockFetchWithHtml('<html><head><title>API Docs</title></head><body>Content</body></html>');
    const page = await fetchPage('https://example.com/docs');
    expect(page.title).toBe('API Docs');
  });

  it('falls back to <h1> for title', async () => {
    mockFetchWithHtml('<html><body><h1>Getting Started</h1><p>Content</p></body></html>');
    const page = await fetchPage('https://example.com/docs');
    expect(page.title).toBe('Getting Started');
  });

  it('strips <script> elements', async () => {
    mockFetchWithHtml('<html><body><script>alert("xss")</script><p>Safe content</p></body></html>');
    const page = await fetchPage('https://example.com/docs');
    expect(page.textContent).not.toContain('alert');
    expect(page.textContent).toContain('Safe content');
  });

  it('strips <style> elements', async () => {
    mockFetchWithHtml('<html><body><style>body { color: red }</style><p>Content</p></body></html>');
    const page = await fetchPage('https://example.com/docs');
    expect(page.textContent).not.toContain('color: red');
    expect(page.textContent).toContain('Content');
  });

  it('strips <nav> and <footer> elements', async () => {
    mockFetchWithHtml(`
      <html><body>
        <nav>Menu items here</nav>
        <main><p>Main content</p></main>
        <footer>Footer links</footer>
      </body></html>
    `);
    const page = await fetchPage('https://example.com/docs');
    expect(page.textContent).not.toContain('Menu items');
    expect(page.textContent).not.toContain('Footer links');
    expect(page.textContent).toContain('Main content');
  });

  // ── Code Block Extraction ────────────────────────────────────

  it('extracts code blocks from <pre> elements', async () => {
    mockFetchWithHtml(`
      <html><body>
        <p>Example:</p>
        <pre>curl -X POST https://api.example.com/v1/create</pre>
      </body></html>
    `);
    const page = await fetchPage('https://example.com/docs');
    expect(page.codeBlocks).toHaveLength(1);
    expect(page.codeBlocks[0]).toContain('curl -X POST');
  });

  it('extracts multiple code blocks', async () => {
    mockFetchWithHtml(`
      <html><body>
        <pre>const client = new API();</pre>
        <pre>client.create({ name: "test" });</pre>
      </body></html>
    `);
    const page = await fetchPage('https://example.com/docs');
    expect(page.codeBlocks.length).toBeGreaterThanOrEqual(2);
  });

  it('ignores tiny code blocks', async () => {
    mockFetchWithHtml('<html><body><pre>ok</pre><p>Content</p></body></html>');
    const page = await fetchPage('https://example.com/docs');
    expect(page.codeBlocks).toHaveLength(0); // "ok" is < 10 chars
  });

  // ── Truncation ───────────────────────────────────────────────

  it('sets truncated flag for long pages', async () => {
    const longContent = 'x'.repeat(60_000);
    mockFetchWithHtml(`<html><body><p>${longContent}</p></body></html>`);
    const page = await fetchPage('https://example.com/docs');
    expect(page.truncated).toBe(true);
    expect(page.textContent.length).toBeLessThanOrEqual(50_000);
  });

  it('does not set truncated for short pages', async () => {
    mockFetchWithHtml('<html><body><p>Short content</p></body></html>');
    const page = await fetchPage('https://example.com/docs');
    expect(page.truncated).toBe(false);
  });

  // ── Response metadata ────────────────────────────────────────

  it('records the URL', async () => {
    mockFetchWithHtml('<html><body>Content</body></html>');
    const page = await fetchPage('https://example.com/docs');
    expect(page.url).toBe('https://example.com/docs');
  });

  it('records fetchedAt timestamp', async () => {
    mockFetchWithHtml('<html><body>Content</body></html>');
    const before = new Date();
    const page = await fetchPage('https://example.com/docs');
    const after = new Date();
    expect(page.fetchedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(page.fetchedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  // ── Error handling ───────────────────────────────────────────

  it('throws on non-200 responses', async () => {
    mockFetchWithHtml('Not Found', 404);
    await expect(fetchPage('https://example.com/docs')).rejects.toThrow('404');
  });

  it('throws on network error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('DNS resolution failed');
    });
    await expect(fetchPage('https://example.com/docs')).rejects.toThrow('DNS resolution failed');
  });
});

describe('fetchPages', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches multiple pages in parallel', async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      return new Response(
        encoder.encode(`<html><body><h1>${urlStr}</h1></body></html>`),
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    });

    const pages = await fetchPages([
      'https://example.com/docs/a',
      'https://example.com/docs/b',
    ]);

    expect(pages).toHaveLength(2);
  });

  it('skips failed pages and continues', async () => {
    let callCount = 0;
    const encoder = new TextEncoder();
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error('Network error');
      return new Response(
        encoder.encode('<html><body><p>Good page</p></body></html>'),
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    });

    const pages = await fetchPages([
      'https://example.com/fail',
      'https://example.com/ok',
    ]);

    expect(pages).toHaveLength(1);
    expect(pages[0].textContent).toContain('Good page');
  });

  it('respects maxPages limit', async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        encoder.encode('<html><body>Content</body></html>'),
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    });

    const pages = await fetchPages(
      ['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com'],
      { maxPages: 2 },
    );

    expect(pages).toHaveLength(2);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
