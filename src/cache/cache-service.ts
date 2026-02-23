import { getRedis } from './redis-client.js';
import type { BotConfig } from '../common/types/bot.js';
import type { SkillDefinition } from '../common/types/skill.js';
import type { ColumnInfo } from '../skill-engine/schema-generator.js';

/**
 * Cache service — Spec #4 Phase 1 implementation.
 *
 * Write-through cache for data that changes rarely but is read on every message:
 * - Bot configuration
 * - Skill definitions (all active skills for a bot)
 * - Table schemas (for SQL generation in the PromptComposer)
 *
 * Strategy: write to Postgres first (source of truth), then write to Redis.
 * On read: try Redis first, fall back to Postgres on miss, backfill cache.
 *
 * TTL: 1 hour. Explicit invalidation on writes means TTL is just a safety net
 * for stale data, not the primary freshness mechanism.
 */

const DEFAULT_TTL = 3600; // 1 hour in seconds
const CACHE_TIMEOUT_MS = 100; // Fall through to DB if Redis is slow

// ─── Cache Keys ────────────────────────────────────────────────

function botConfigKey(botId: string): string {
  return `bot:${botId}:config`;
}

function botSkillsKey(botId: string): string {
  return `bot:${botId}:skills`;
}

function botSchemasKey(botId: string): string {
  return `bot:${botId}:schemas`;
}

// ─── Bot Config Cache ──────────────────────────────────────────

export async function getCachedBotConfig(botId: string): Promise<BotConfig | null> {
  return getCached<BotConfig>(botConfigKey(botId));
}

export async function setCachedBotConfig(botId: string, config: BotConfig): Promise<void> {
  await setCached(botConfigKey(botId), config);
}

export async function invalidateBotConfig(botId: string): Promise<void> {
  await invalidate(botConfigKey(botId));
}

// ─── Skills Cache ──────────────────────────────────────────────

export async function getCachedSkills(botId: string): Promise<SkillDefinition[] | null> {
  return getCached<SkillDefinition[]>(botSkillsKey(botId));
}

export async function setCachedSkills(botId: string, skills: SkillDefinition[]): Promise<void> {
  await setCached(botSkillsKey(botId), skills);
}

export async function invalidateSkills(botId: string): Promise<void> {
  await invalidate(botSkillsKey(botId));
}

// ─── Table Schemas Cache ───────────────────────────────────────

export interface CachedTableSchemas {
  [tableName: string]: ColumnInfo[];
}

export async function getCachedTableSchemas(botId: string): Promise<CachedTableSchemas | null> {
  return getCached<CachedTableSchemas>(botSchemasKey(botId));
}

export async function setCachedTableSchemas(botId: string, schemas: CachedTableSchemas): Promise<void> {
  await setCached(botSchemasKey(botId), schemas);
}

export async function invalidateTableSchemas(botId: string): Promise<void> {
  await invalidate(botSchemasKey(botId));
}

// ─── Model Pricing Cache ──────────────────────────────────────

import type { ModelPricing } from '../common/types/usage.js';

const PRICING_TTL = 86400; // 24 hours — pricing rarely changes

function modelPricingKey(): string {
  return 'config:model_pricing';
}

export async function getCachedModelPricing(): Promise<ModelPricing[] | null> {
  return getCached<ModelPricing[]>(modelPricingKey());
}

export async function setCachedModelPricing(pricing: ModelPricing[]): Promise<void> {
  await setCached(modelPricingKey(), pricing, PRICING_TTL);
}

export async function invalidateModelPricing(): Promise<void> {
  await invalidate(modelPricingKey());
}

// ─── Convenience: invalidate everything for a bot ──────────────

/**
 * Call this whenever a skill is created, updated, or deleted.
 * Invalidates all cached data for the bot so the next message
 * picks up fresh data from Postgres.
 */
export async function invalidateBotCache(botId: string): Promise<void> {
  await Promise.all([
    invalidateBotConfig(botId),
    invalidateSkills(botId),
    invalidateTableSchemas(botId),
  ]);
}

// ─── Generic Cache Helpers ─────────────────────────────────────

async function getCached<T>(key: string): Promise<T | null> {
  try {
    const redis = getRedis();
    const raw = await withTimeout(redis.get(key), CACHE_TIMEOUT_MS);
    if (!raw) return null;
    return JSON.parse(raw, dateReviver) as T;
  } catch {
    // Cache miss or error — caller falls back to database.
    // This is intentionally silent: cache is an optimization, not a requirement.
    return null;
  }
}

async function setCached<T>(key: string, value: T, ttl: number = DEFAULT_TTL): Promise<void> {
  try {
    const redis = getRedis();
    const serialized = JSON.stringify(value);
    await withTimeout(redis.setex(key, ttl, serialized), CACHE_TIMEOUT_MS);
  } catch {
    // Cache write failure is not critical — data is in Postgres.
    // Log for monitoring, but don't throw.
    console.warn(`Cache write failed for key: ${key}`);
  }
}

async function invalidate(key: string): Promise<void> {
  try {
    const redis = getRedis();
    await withTimeout(redis.del(key), CACHE_TIMEOUT_MS);
  } catch {
    console.warn(`Cache invalidation failed for key: ${key}`);
  }
}

// ─── Utilities ─────────────────────────────────────────────────

/**
 * Revive Date strings from JSON.parse so cached BotConfig.createdAt etc.
 * come back as Date objects, not strings.
 */
function dateReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    const date = new Date(value);
    if (!isNaN(date.getTime())) return date;
  }
  return value;
}

/**
 * Wrap a Redis operation with a timeout so a slow Redis
 * doesn't block the message hot path. Falls through to Postgres instead.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Cache timeout')), ms);
    promise
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}
