-- Migration 003: Soul System
--
-- Adds structured personality (SOUL) to bots.
-- Each bot gets its own soul stored as JSONB with 5 layers:
-- personalityTraits, values, communicationStyle, behavioralRules, decisionFramework
--
-- The flat personality/context TEXT columns remain for backward compatibility.
-- Application layer prefers soul when present, falls back to personality+context.

ALTER TABLE bots ADD COLUMN soul JSONB DEFAULT NULL;
