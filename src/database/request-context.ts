/**
 * Async request context for propagating the authenticated userId
 * through the entire request lifecycle (hooks → handler → repositories → pool).
 *
 * The auth middleware calls `enterWith({ userId })` once per request.
 * The pool's `query()` function reads `getCurrentUserId()` to decide
 * whether to set the Postgres session variable for Row-Level Security.
 *
 * CLI, migrations, and the scheduler's startup query run without a
 * request context — those paths bypass RLS (table owner is exempt).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
  userId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Returns the authenticated userId for the current async context,
 * or null if no user context is active (CLI, migrations, scheduler startup).
 */
export function getCurrentUserId(): string | null {
  return requestContext.getStore()?.userId ?? null;
}
