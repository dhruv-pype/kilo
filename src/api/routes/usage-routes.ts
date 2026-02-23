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
 */
export async function usageRoutes(app: FastifyInstance): Promise<void> {

  // ─── Total Spend ────────────────────────────────────────────

  app.get<{
    Querystring: {
      userId: string;
      startDate?: string;
      endDate?: string;
    };
  }>('/api/usage/summary', async (request) => {
    const { userId, startDate, endDate } = request.query;

    const summary = await usageRepo.getTotalSpend(
      userId,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );

    return { usage: summary };
  });

  // ─── Breakdown ──────────────────────────────────────────────

  app.get<{
    Querystring: {
      userId: string;
      groupBy: 'model' | 'bot' | 'day' | 'month';
      botId?: string;
      model?: string;
      startDate?: string;
      endDate?: string;
    };
  }>('/api/usage/breakdown', async (request) => {
    const q = request.query;

    const breakdown = await usageRepo.getSpendBreakdown({
      userId: q.userId,
      groupBy: q.groupBy,
      botId: q.botId,
      model: q.model,
      startDate: q.startDate ? new Date(q.startDate) : undefined,
      endDate: q.endDate ? new Date(q.endDate) : undefined,
    });

    return { breakdown };
  });
}
