import { describe, it, expect } from 'vitest';
import { requestContext, getCurrentUserId } from '@database/request-context.js';

describe('requestContext', () => {
  it('returns null when no context is active', () => {
    expect(getCurrentUserId()).toBeNull();
  });

  it('returns userId when context is active', () => {
    requestContext.run({ userId: 'user-123' }, () => {
      expect(getCurrentUserId()).toBe('user-123');
    });
  });

  it('isolates contexts between async operations', async () => {
    const results: (string | null)[] = [];

    await Promise.all([
      requestContext.run({ userId: 'user-A' }, async () => {
        await new Promise(r => setTimeout(r, 10));
        results.push(getCurrentUserId());
      }),
      requestContext.run({ userId: 'user-B' }, async () => {
        await new Promise(r => setTimeout(r, 5));
        results.push(getCurrentUserId());
      }),
    ]);

    expect(results).toContain('user-A');
    expect(results).toContain('user-B');
  });

  it('enterWith sets context for current execution', () => {
    // enterWith doesn't need a callback wrapper
    requestContext.enterWith({ userId: 'user-456' });
    expect(getCurrentUserId()).toBe('user-456');
  });
});
