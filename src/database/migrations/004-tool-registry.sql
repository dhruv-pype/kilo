-- Migration 004: Tool Registry
--
-- Adds tool_registry table for external API integrations.
-- Each bot can register multiple tools (Canva, Stripe, etc.).
-- Auth credentials are stored as encrypted JSONB via the credential vault.
-- Endpoints describe the available API operations for each tool.

CREATE TABLE tool_registry (
    tool_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id        UUID NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    base_url      TEXT NOT NULL,
    auth_type     TEXT NOT NULL CHECK (auth_type IN ('api_key', 'bearer', 'oauth2', 'custom_header')),
    auth_config   JSONB NOT NULL,                -- encrypted via credential vault
    endpoints     JSONB NOT NULL DEFAULT '[]',   -- array of ToolEndpoint objects
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup tools by bot
CREATE INDEX idx_tool_registry_bot ON tool_registry(bot_id);

-- Prevent duplicate tool names per bot
CREATE UNIQUE INDEX idx_tool_registry_bot_name ON tool_registry(bot_id, name);

-- Fast lookup of active tools (partial index, same pattern as skills table)
CREATE INDEX idx_tool_registry_bot_active ON tool_registry(bot_id) WHERE is_active = true;
