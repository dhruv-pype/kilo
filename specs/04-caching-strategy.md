# Spec #4: Redis Hot Cache + Intent-Based Selective Loading

## Decision
Two-phase optimization of the message hot path:
- **Phase 1** (build immediately): Redis cache for bot config and skill definitions.
- **Phase 2** (build after SkillMatcher is stable): Intent-based selective loading — only fetch memory, RAG, conversation history, and skill data that the matched skill actually needs.

## Problem Being Solved
The PRD's message flow (Section 6.3) loads everything on every message: bot config, conversation history, memory context, all active skills, and RAG results. For a bot with 14 skills, 100+ message history, and uploaded documents, this is significant I/O on the hot path. Chat apps live or die on response latency — users form opinions in the first 2 seconds.

## Design

### Phase 1: Redis Hot Cache for Static Data

#### What Gets Cached

| Data | Cache Key | TTL | Invalidation |
|---|---|---|---|
| Bot configuration | `bot:{bot_id}:config` | 1 hour | On bot settings change |
| Skill definitions (all for a bot) | `bot:{bot_id}:skills` | 1 hour | On skill create/update/delete |
| Individual skill definition | `skill:{skill_id}` | 1 hour | On skill update |
| User profile / preferences | `user:{user_id}:profile` | 1 hour | On profile change |
| Table schemas (for SQL generation) | `bot:{bot_id}:schemas` | 1 hour | On skill create/update/delete |

#### What Does NOT Get Cached

| Data | Reason |
|---|---|
| Conversation history | Changes every message — caching would require invalidation on every write. The database read is fast enough with proper indexing. |
| Memory facts | Extracted asynchronously — cache would frequently be stale. Semantic queries need the vector DB anyway. |
| Skill table data (orders, sales) | Changes with every skill interaction. Postgres handles this well with connection pooling. |
| RAG results | Query-dependent — each message searches for different content. Embedding search is already optimized. |

#### Cache Write Strategy: Write-Through

When a skill is created or updated:
1. Write to PostgreSQL (source of truth)
2. Write to Redis (cache)
3. If Redis write fails: log error, continue — stale cache expires via TTL

On read:
1. Read from Redis
2. Cache miss → read from PostgreSQL → write to Redis
3. Return data

This is a simple, well-understood pattern. No cache stampede risk because bot config/skills change infrequently (minutes to hours between changes, not seconds).

#### Cache Serialization

Store as JSON strings in Redis. Skill definitions are typically 1-5KB each; a bot with 50 skills is ~250KB — well within Redis single-key limits.

```
SET bot:a1b2c3d4:skills '[{"skill_id":"...","name":"Order Tracker",...},...]' EX 3600
```

#### Connection Management

- Single Redis instance for v1 (Redis Cluster when >10K concurrent users)
- Connection pool: 20 connections shared across Bot Runtime instances
- Timeout: 100ms for cache reads (fall through to Postgres on timeout)

#### Expected Impact

| Operation | Without Cache | With Cache | Improvement |
|---|---|---|---|
| Load bot config | ~15ms (Postgres) | ~1ms (Redis) | 14ms saved |
| Load all skills | ~25ms (Postgres) | ~2ms (Redis) | 23ms saved |
| Load table schemas | ~10ms (Postgres) | ~1ms (Redis) | 9ms saved |
| **Total per message** | **~50ms** | **~4ms** | **~46ms saved** |

This is 46ms saved on every single message. At 60 messages/user/week and 10K active users, that's 31.2 million ms (8.7 hours) of cumulative user wait time saved per week.

### Phase 2: Intent-Based Selective Loading

#### Concept

After the SkillMatcher (Spec #2) identifies which skill handles a message, it returns `ContextRequirements` that tells the Orchestrator exactly what data to load. This avoids loading data that won't be used.

#### Context Requirement Profiles

Common patterns, pre-defined per skill type:

| Skill Type | Conversation History | Memory | RAG | Skill Data |
|---|---|---|---|---|
| Simple reminder ("remind me at 3pm") | Last 2 messages | No | No | No |
| Data logging ("new order: ...") | Last 2 messages | No | No | No (write-only) |
| Data query ("what orders this week?") | Last 5 messages | No | No | Yes (read) |
| Knowledge Q&A ("what's in our menu?") | Last 5 messages | Basic facts | Yes | No |
| Analysis ("top sellers this month") | Last 5 messages | No | No | Yes (read, multiple tables) |
| General chat ("how are you?") | Last 10 messages | Basic facts | No | No |
| Skill proposal (no match) | Last 10 messages | Skill list | No | No |
| Morning briefing (scheduled) | None | Full context | No | Yes (multiple tables) |

#### SkillMatcher Enhancement

The SkillMatcher's `ContextRequirements` (from Spec #2) drives selective loading:

```typescript
// Example: "What orders do I have this week?"
{
  needsConversationHistory: true,
  historyDepth: 5,                    // only last 5 messages
  needsMemory: false,                 // no memory needed for a data query
  needsRAG: false,                    // no document search needed
  needsSkillData: true,
  skillDataQuery: "pickup_date >= CURRENT_DATE AND pickup_date < CURRENT_DATE + INTERVAL '7 days'"
}
```

vs. the naive approach which would load: full conversation history + all memory facts + RAG search + all skill data.

#### Data Loading Strategy

The Orchestrator uses `ContextRequirements` to make parallel, selective fetches:

```typescript
async function loadContext(reqs: ContextRequirements, botId: string): Promise<Context> {
  const fetches: Promise<any>[] = [];

  if (reqs.needsConversationHistory) {
    fetches.push(loadHistory(botId, reqs.historyDepth));
  }
  if (reqs.needsMemory) {
    fetches.push(reqs.memoryQuery
      ? searchMemory(botId, reqs.memoryQuery)
      : loadBasicFacts(botId));
  }
  if (reqs.needsRAG) {
    fetches.push(searchKnowledge(botId, reqs.ragQuery));
  }
  if (reqs.needsSkillData) {
    fetches.push(querySkillData(botId, reqs.skillDataQuery));
  }

  // All fetches run in parallel
  const results = await Promise.all(fetches);
  return assembleContext(results);
}
```

Key: **parallel fetches**. Even when we do load multiple data sources, they run concurrently rather than sequentially. This is a significant latency win.

#### Expected Impact

| Message Type | Without Selective Loading | With Selective Loading | Improvement |
|---|---|---|---|
| Simple reminder | ~200ms (load everything) | ~20ms (2 messages, no DB queries) | 90% |
| Data query | ~250ms (load everything + full table scan) | ~80ms (5 messages + indexed query) | 68% |
| Knowledge Q&A | ~300ms (load everything + RAG) | ~150ms (5 messages + targeted RAG) | 50% |
| General chat | ~200ms (load everything) | ~40ms (10 messages + basic facts) | 80% |

These are pre-LLM latencies. The LLM call itself (200ms–2s depending on model) is the dominant cost, but shaving 100-200ms off the pre-LLM assembly is noticeable and compounds with scale.

### 3. Cache Monitoring

Instrument the following metrics from day 1:

| Metric | Purpose |
|---|---|
| `cache_hit_rate` | Should be >95% for bot config/skills. Alert if drops below 90%. |
| `cache_latency_p50` / `p99` | Redis read latency. Alert if p99 > 10ms. |
| `cache_miss_reason` | Track why misses happen: TTL expiry, invalidation, cold start. |
| `context_load_time_ms` | Total time to assemble context per message. Primary optimization target. |
| `context_load_components` | Which components were loaded (history, memory, RAG, data). Helps identify if selective loading is working. |
| `skill_match_time_ms` | Time for SkillMatcher (fast path vs slow path). |

### 4. Implementation Order

| Step | Phase | Depends On | Effort |
|---|---|---|---|
| Redis connection + basic cache helper | Phase 1 | Infrastructure setup | 1-2 days |
| Bot config caching | Phase 1 | Redis connection | 1 day |
| Skill definition caching with invalidation | Phase 1 | Redis connection | 1-2 days |
| Table schema caching | Phase 1 | Spec #1 (relational schema) | 1 day |
| ContextRequirements on SkillMatch | Phase 2 | Spec #2 (SkillMatcher interface) | 2-3 days |
| Parallel selective context loading | Phase 2 | ContextRequirements | 2-3 days |
| Context requirement profiles per skill type | Phase 2 | Real usage data | 1-2 days |
| Monitoring + alerting | Both | All above | 1-2 days |

Phase 1 total: ~4-5 days. Phase 2 total: ~6-8 days. Phase 2 can be deferred until after launch if needed, but Phase 1 should ship with the initial release.

### 5. What This Does NOT Cover

- **LLM response caching**: Caching LLM responses for identical queries is a future optimization. The challenge is cache key design — "What orders this week?" on Monday and Tuesday return different results. Needs careful consideration of staleness.
- **CDN / edge caching**: Not relevant for v1 — all traffic is authenticated API calls, not static assets.
- **Connection pooling for PostgreSQL**: Assumed to be handled by the ORM/connection library (e.g., Prisma's connection pool, pg-pool). Not a custom concern.
- **Rate limiting**: Message-per-minute limits (from the pricing tiers) are enforced at the API Gateway, not in the caching layer.
