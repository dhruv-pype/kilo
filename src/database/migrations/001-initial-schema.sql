-- Core tables for Kilo.
-- These live in the default "public" schema.
-- Per-bot skill data tables live in bot-specific schemas (created dynamically).

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Users ─────────────────────────────────────────────────────

CREATE TABLE users (
    user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT UNIQUE,
    apple_user_id TEXT UNIQUE,
    display_name  TEXT NOT NULL,
    tier          TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'plus', 'pro')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_apple_id ON users(apple_user_id);

-- ─── Bots ──────────────────────────────────────────────────────

CREATE TABLE bots (
    bot_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    personality   TEXT NOT NULL DEFAULT '',
    context       TEXT NOT NULL DEFAULT '',
    schema_name   TEXT NOT NULL UNIQUE,  -- Postgres schema for this bot's skill data
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bots_user ON bots(user_id);

-- ─── Skills ────────────────────────────────────────────────────

CREATE TABLE skills (
    skill_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id                UUID NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
    name                  TEXT NOT NULL,
    description           TEXT NOT NULL DEFAULT '',
    trigger_patterns      TEXT[] NOT NULL DEFAULT '{}',
    behavior_prompt       TEXT NOT NULL,
    input_schema          JSONB,
    output_format         TEXT NOT NULL DEFAULT 'text' CHECK (output_format IN ('text', 'structured_card', 'notification', 'action')),
    schedule              TEXT,            -- cron expression
    data_table            TEXT,            -- table name in bot's schema
    readable_tables       TEXT[] NOT NULL DEFAULT '{}',
    table_schema_ddl      TEXT,            -- generated DDL for reference
    required_integrations TEXT[] NOT NULL DEFAULT '{}',
    created_by            TEXT NOT NULL DEFAULT 'user_conversation' CHECK (created_by IN ('system', 'user_conversation', 'auto_proposed')),
    version               INTEGER NOT NULL DEFAULT 1,
    performance_score     DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    is_active             BOOLEAN NOT NULL DEFAULT true,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_skills_bot ON skills(bot_id);
CREATE INDEX idx_skills_bot_active ON skills(bot_id) WHERE is_active = true;

-- ─── Messages ──────────────────────────────────────────────────

CREATE TABLE messages (
    message_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    UUID NOT NULL,
    bot_id        UUID NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content       TEXT NOT NULL,
    attachments   JSONB NOT NULL DEFAULT '[]',
    skill_id      UUID REFERENCES skills(skill_id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_bot_session ON messages(bot_id, session_id, created_at);
CREATE INDEX idx_messages_bot_recent ON messages(bot_id, created_at DESC);

-- ─── Memory Facts ──────────────────────────────────────────────

CREATE TABLE memory_facts (
    fact_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id        UUID NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
    key           TEXT NOT NULL,
    value         TEXT NOT NULL,
    source        TEXT NOT NULL CHECK (source IN ('user_stated', 'inferred', 'document')),
    confidence    DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_memory_bot ON memory_facts(bot_id);
CREATE UNIQUE INDEX idx_memory_bot_key ON memory_facts(bot_id, key);

-- ─── Skill Proposal History ────────────────────────────────────
-- Tracks proposed skills so we don't re-propose dismissed ones (Spec #2: SkillProposer)

CREATE TABLE skill_proposals (
    proposal_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id        UUID NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
    proposed_name TEXT NOT NULL,
    description   TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
    dismissed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_proposals_bot ON skill_proposals(bot_id);
CREATE INDEX idx_proposals_bot_dismissed ON skill_proposals(bot_id, dismissed_at)
    WHERE status = 'dismissed';
