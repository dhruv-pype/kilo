-- LLM usage tracking for cost visibility.
-- Every LLM call logs a row here. The iOS app queries aggregates via the usage API.

CREATE TABLE llm_usage (
    usage_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    bot_id            UUID REFERENCES bots(bot_id) ON DELETE SET NULL,
    session_id        UUID,
    message_id        UUID,
    provider          TEXT NOT NULL,               -- 'anthropic' | 'openai'
    model             TEXT NOT NULL,               -- 'claude-sonnet-4-5-20250929', 'gpt-4o', etc.
    task_type         TEXT NOT NULL,               -- 'simple_qa' | 'skill_execution' | etc.
    prompt_tokens     INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    total_tokens      INTEGER NOT NULL GENERATED ALWAYS AS (prompt_tokens + completion_tokens) STORED,
    cost_usd          DOUBLE PRECISION NOT NULL,   -- pre-calculated at write time
    latency_ms        INTEGER NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Query patterns: user total, user+time range, user+bot, user+model
CREATE INDEX idx_llm_usage_user         ON llm_usage(user_id, created_at DESC);
CREATE INDEX idx_llm_usage_user_bot     ON llm_usage(user_id, bot_id, created_at DESC);
CREATE INDEX idx_llm_usage_user_model   ON llm_usage(user_id, model, created_at DESC);

-- Model pricing configuration.
-- Kept in a table (not hardcoded) so pricing updates don't require a deployment.
CREATE TABLE model_pricing (
    model                           TEXT PRIMARY KEY,
    provider                        TEXT NOT NULL,
    input_cost_per_million_tokens   DOUBLE PRECISION NOT NULL,
    output_cost_per_million_tokens  DOUBLE PRECISION NOT NULL,
    effective_from                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed current pricing (as of Feb 2026)
INSERT INTO model_pricing (model, provider, input_cost_per_million_tokens, output_cost_per_million_tokens) VALUES
    ('claude-haiku-4-5-20251001',   'anthropic',  0.80,   4.00),
    ('claude-sonnet-4-5-20250929',  'anthropic',  3.00,  15.00),
    ('claude-opus-4-6',             'anthropic', 15.00,  75.00),
    ('gpt-4o-mini',                 'openai',     0.15,   0.60),
    ('gpt-4o',                      'openai',     2.50,  10.00);
