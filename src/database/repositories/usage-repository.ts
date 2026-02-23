import { v4 as uuidv4 } from 'uuid';
import { query } from '../pool.js';
import type { UsageSummary, UsageBreakdown, UsageQueryParams, ModelPricing } from '../../common/types/usage.js';

/**
 * Usage Repository — stores and queries LLM usage records.
 *
 * Why pre-calculate cost at insert time:
 * - SUM queries are trivial (no JOINs to pricing table)
 * - Historical cost is locked in — pricing changes don't retroactively alter data
 * - The iOS app gets fast responses for "how much have I spent?"
 */

// ─── Insert ─────────────────────────────────────────────────────

export interface InsertUsageInput {
  userId: string;
  botId: string | null;
  sessionId: string | null;
  messageId: string | null;
  provider: string;
  model: string;
  taskType: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
}

export async function insertUsage(input: InsertUsageInput): Promise<void> {
  await query(
    `INSERT INTO llm_usage (usage_id, user_id, bot_id, session_id, message_id,
       provider, model, task_type, prompt_tokens, completion_tokens, cost_usd, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      uuidv4(),
      input.userId,
      input.botId,
      input.sessionId,
      input.messageId,
      input.provider,
      input.model,
      input.taskType,
      input.promptTokens,
      input.completionTokens,
      input.costUsd,
      input.latencyMs,
    ],
  );
}

// ─── Total Spend ────────────────────────────────────────────────

export async function getTotalSpend(
  userId: string,
  startDate?: Date,
  endDate?: Date,
): Promise<UsageSummary> {
  const conditions: string[] = ['user_id = $1'];
  const params: unknown[] = [userId];

  if (startDate) {
    params.push(startDate);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (endDate) {
    params.push(endDate);
    conditions.push(`created_at <= $${params.length}`);
  }

  const result = await query(
    `SELECT
       COALESCE(SUM(cost_usd), 0)             AS total_cost_usd,
       COALESCE(SUM(prompt_tokens), 0)         AS total_prompt_tokens,
       COALESCE(SUM(completion_tokens), 0)     AS total_completion_tokens,
       COUNT(*)::INTEGER                        AS total_calls
     FROM llm_usage
     WHERE ${conditions.join(' AND ')}`,
    params,
  );

  const row = result.rows[0];
  return {
    totalCostUsd: parseFloat(row.total_cost_usd),
    totalPromptTokens: parseInt(row.total_prompt_tokens, 10),
    totalCompletionTokens: parseInt(row.total_completion_tokens, 10),
    totalCalls: parseInt(row.total_calls, 10),
  };
}

// ─── Breakdown by model / bot / day / month ─────────────────────

export async function getSpendBreakdown(params: UsageQueryParams): Promise<UsageBreakdown[]> {
  const conditions: string[] = ['user_id = $1'];
  const queryParams: unknown[] = [params.userId];

  if (params.botId) {
    queryParams.push(params.botId);
    conditions.push(`bot_id = $${queryParams.length}`);
  }
  if (params.model) {
    queryParams.push(params.model);
    conditions.push(`model = $${queryParams.length}`);
  }
  if (params.startDate) {
    queryParams.push(params.startDate);
    conditions.push(`created_at >= $${queryParams.length}`);
  }
  if (params.endDate) {
    queryParams.push(params.endDate);
    conditions.push(`created_at <= $${queryParams.length}`);
  }

  const groupBy = params.groupBy ?? 'model';
  let groupExpr: string;
  let orderExpr: string;

  switch (groupBy) {
    case 'model':
      groupExpr = 'model';
      orderExpr = 'total_cost_usd DESC';
      break;
    case 'bot':
      groupExpr = 'bot_id::TEXT';
      orderExpr = 'total_cost_usd DESC';
      break;
    case 'day':
      groupExpr = "TO_CHAR(created_at, 'YYYY-MM-DD')";
      orderExpr = 'group_key DESC';
      break;
    case 'month':
      groupExpr = "TO_CHAR(created_at, 'YYYY-MM')";
      orderExpr = 'group_key DESC';
      break;
  }

  const result = await query(
    `SELECT
       ${groupExpr}                             AS group_key,
       COALESCE(SUM(cost_usd), 0)              AS total_cost_usd,
       COALESCE(SUM(total_tokens), 0)           AS total_tokens,
       COUNT(*)::INTEGER                         AS call_count
     FROM llm_usage
     WHERE ${conditions.join(' AND ')}
     GROUP BY ${groupExpr}
     ORDER BY ${orderExpr}`,
    queryParams,
  );

  return result.rows.map((row: Record<string, unknown>) => ({
    groupKey: String(row.group_key),
    totalCostUsd: parseFloat(row.total_cost_usd as string),
    totalTokens: parseInt(row.total_tokens as string, 10),
    callCount: parseInt(row.call_count as string, 10),
  }));
}

// ─── Model Pricing ──────────────────────────────────────────────

export async function getAllModelPricing(): Promise<ModelPricing[]> {
  const result = await query(
    `SELECT model, provider, input_cost_per_million_tokens, output_cost_per_million_tokens
     FROM model_pricing
     ORDER BY provider, model`,
  );

  return result.rows.map((row: Record<string, unknown>) => ({
    model: row.model as string,
    provider: row.provider as string,
    inputCostPerMillionTokens: parseFloat(row.input_cost_per_million_tokens as string),
    outputCostPerMillionTokens: parseFloat(row.output_cost_per_million_tokens as string),
  }));
}

export async function getModelPricing(model: string): Promise<ModelPricing | null> {
  const result = await query(
    `SELECT model, provider, input_cost_per_million_tokens, output_cost_per_million_tokens
     FROM model_pricing WHERE model = $1`,
    [model],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    model: row.model as string,
    provider: row.provider as string,
    inputCostPerMillionTokens: parseFloat(row.input_cost_per_million_tokens as string),
    outputCostPerMillionTokens: parseFloat(row.output_cost_per_million_tokens as string),
  };
}
