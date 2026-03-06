import type { FastifyInstance } from 'fastify';
import * as usageRepo from '../../database/repositories/usage-repository.js';

/**
 * Usage routes — LLM cost tracking API for the iOS app.
 *
 * Two endpoints:
 * 1. /api/usage/summary  → total spend (for the main dashboard card)
 * 2. /api/usage/breakdown → grouped breakdown (for the detailed view)
 *
 * Both support date filtering so the iOS app can show
 * "This month: $12.34" or "Last 7 days: $3.21".
 *
 * userId is extracted from the JWT (request.userId), not query params.
 */
export async function usageRoutes(app: FastifyInstance): Promise<void> {

  // ─── Total Spend ────────────────────────────────────────────

  app.get<{
    Querystring: {
      startDate?: string;
      endDate?: string;
    };
  }>('/api/usage/summary', async (request) => {
    const { startDate, endDate } = request.query;

    const summary = await usageRepo.getTotalSpend(
      request.userId as string,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );

    return { usage: summary };
  });

  // ─── Breakdown ──────────────────────────────────────────────

  app.get<{
    Querystring: {
      groupBy: 'model' | 'bot' | 'day' | 'month';
      botId?: string;
      model?: string;
      startDate?: string;
      endDate?: string;
    };
  }>('/api/usage/breakdown', async (request) => {
    const q = request.query;

    const breakdown = await usageRepo.getSpendBreakdown({
      userId: request.userId as string,
      groupBy: q.groupBy,
      botId: q.botId,
      model: q.model,
      startDate: q.startDate ? new Date(q.startDate) : undefined,
      endDate: q.endDate ? new Date(q.endDate) : undefined,
    });

    return { breakdown };
  });
}
