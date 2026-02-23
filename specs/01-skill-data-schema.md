# Spec #1: Per-Bot Relational Schema with Dynamic Tables

## Decision
Replace the PRD's per-skill JSON `data_store` field with a per-bot relational schema in PostgreSQL. Each skill declares a table schema; the Skill Engine generates DDL at skill creation time.

## Problem Being Solved
The PRD specifies a `data_store: JSON` field on each Skill Definition Object. This means every skill stores its data as an opaque JSON blob in a single database row. This fails on:
- **Queryability**: No SQL filtering, sorting, or aggregation on skill data.
- **Cross-skill access**: Sales Insights can't query Order Tracker data without deserializing the entire blob.
- **Concurrency**: Two simultaneous writes to the same JSON blob = data loss.
- **Growth**: JSON blobs grow unbounded with no partitioning or pagination.

## Design

### 1. Schema Namespace Strategy

Each bot gets a PostgreSQL schema (namespace), not a separate database:

```sql
-- When bot is created:
CREATE SCHEMA bot_<bot_id>;
```

This provides:
- Logical isolation between bots (one user's data can't leak to another)
- Easy cleanup on bot deletion (`DROP SCHEMA bot_<bot_id> CASCADE`)
- Shared connection pool across all bots (no per-bot connection overhead)

**Naming convention**: `bot_<first_8_chars_of_uuid>` (e.g., `bot_a1b2c3d4`)

### 2. Skill Table Generation

When a skill is created, the Skill Engine generates a table in the bot's schema. The table schema is derived from the skill's `input_schema` (JSON Schema → DDL).

#### Mapping Rules: JSON Schema → PostgreSQL

| JSON Schema Type | PostgreSQL Type | Notes |
|---|---|---|
| `string` | `TEXT` | Default |
| `string` with `format: date` | `DATE` | |
| `string` with `format: date-time` | `TIMESTAMPTZ` | |
| `string` with `format: email` | `TEXT` + CHECK | |
| `string` with `enum` | `TEXT` + CHECK | |
| `number` | `DOUBLE PRECISION` | |
| `integer` | `INTEGER` | |
| `boolean` | `BOOLEAN` | |
| `array` | `JSONB` | Arrays stay as JSONB — simple and sufficient |
| `object` (nested) | `JSONB` | Nested objects stay as JSONB |

#### Example: Order Tracker Skill

The skill's `input_schema`:
```json
{
  "type": "object",
  "properties": {
    "customer_name": { "type": "string" },
    "phone": { "type": "string" },
    "cake_size": { "type": "string", "enum": ["single", "2-tier", "3-tier"] },
    "flavor": { "type": "string" },
    "decoration": { "type": "string" },
    "pickup_date": { "type": "string", "format": "date" },
    "confirmed": { "type": "boolean" }
  },
  "required": ["customer_name", "pickup_date"]
}
```

Generated DDL:
```sql
CREATE TABLE bot_a1b2c3d4.orders (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_name TEXT NOT NULL,
    phone       TEXT,
    cake_size   TEXT CHECK (cake_size IN ('single', '2-tier', '3-tier')),
    flavor      TEXT,
    decoration  TEXT,
    pickup_date DATE NOT NULL,
    confirmed   BOOLEAN DEFAULT false,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now(),
    skill_id    UUID NOT NULL REFERENCES skills(skill_id)
);

CREATE INDEX idx_orders_pickup ON bot_a1b2c3d4.orders(pickup_date);
CREATE INDEX idx_orders_customer ON bot_a1b2c3d4.orders(customer_name);
```

Every generated table gets:
- `id` (UUID PK)
- `created_at` / `updated_at` (audit trail)
- `skill_id` (FK back to the skill that owns this table — enables data lineage)

#### Auto-generated indexes:
- All `date` / `datetime` columns get a B-tree index (most common query pattern: "what's coming up this week?")
- All columns in `required` get a B-tree index (commonly queried fields)
- No index on free-text fields unless explicitly requested

### 3. Table Naming

The Skill Engine generates a table name from the skill name:
- Lowercase, underscored: "Order Tracker" → `orders`
- Pluralized by default (since tables hold collections)
- Collision handling: if `orders` exists, append skill_id suffix: `orders_a1b2`

The table name is stored on the Skill Definition Object as a new field: `data_table: string`.

### 4. Cross-Skill Data Access

Skills declare which tables they can **read** (not just their own). This is stored on the Skill Definition Object:

```json
{
  "skill_id": "...",
  "name": "Sales Insights",
  "data_table": "sales_insights",
  "readable_tables": ["orders", "daily_sales"],
  "behavior_prompt": "You have access to the orders table and daily_sales table..."
}
```

The PromptComposer (from Spec #2) includes the table schemas in the LLM prompt so the model can generate valid queries. The Bot Runtime executes queries through a **read-only SQL executor** that:
- Only allows SELECT statements on declared `readable_tables`
- Enforces the bot's schema namespace (no cross-bot access)
- Has a query timeout (5 seconds) and row limit (1000 rows)
- Logs all queries for debugging

### 5. Schema Migrations

When a user refines a skill ("also track the deposit amount"), the Skill Engine:
1. Generates an `ALTER TABLE ADD COLUMN` statement
2. Validates it won't break existing data
3. Applies it within a transaction
4. Increments the skill's `version` field

Column removal is **never automatic** — if a user says "stop tracking phone numbers," the column is kept but excluded from the behavior prompt. This prevents data loss. A separate "data cleanup" flow (future) can handle actual column drops with user confirmation.

### 6. Updated Skill Definition Object

Changes to the PRD's schema (Section 6.2):

| Field | Change |
|---|---|
| `data_store` | **REMOVED** — replaced by relational tables |
| `data_table` | **NEW** — name of this skill's table in the bot's schema |
| `readable_tables` | **NEW** — list of other skill tables this skill can query |
| `table_schema` | **NEW** — the generated DDL (stored for reference/versioning) |
| `input_schema` | Unchanged — now also drives table generation |

### 7. Limits and Safety

| Constraint | Limit | Rationale |
|---|---|---|
| Tables per bot | 50 | Prevents schema bloat. Aligned with Pro tier's unlimited skills — even unlimited won't hit 50 data-bearing skills |
| Columns per table | 30 | JSON Schema objects rarely have more. Prevents LLM from generating absurdly wide schemas |
| Rows per table | 100,000 | Prevents unbounded growth. Archiving strategy needed beyond this |
| Query timeout | 5 seconds | Prevents runaway queries from blocking the connection pool |
| Query result limit | 1,000 rows | Prevents OOM on the Bot Runtime from massive result sets |

### 8. What This Does NOT Cover
- **Full-text search on skill data**: Use the existing Knowledge Store (vector DB) for semantic search. Relational tables are for structured CRUD.
- **Complex analytics**: v1 supports simple aggregations (COUNT, SUM, AVG, MAX, MIN, GROUP BY). Complex analytics (window functions, CTEs) are out of scope.
- **Multi-bot data sharing**: Each bot has its own schema. Cross-bot queries are not supported in v1. (Relates to PRD open question: "Should bots talk to each other?")
