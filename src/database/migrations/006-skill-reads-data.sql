-- Migration 006: Add reads_data column to skills
-- Replaces the isQueryLikeSkill() keyword heuristic with an explicit field.
-- When true, the orchestrator pre-loads a snapshot of the skill's data table
-- into the LLM prompt before execution.

ALTER TABLE skills ADD COLUMN reads_data BOOLEAN NOT NULL DEFAULT false;
