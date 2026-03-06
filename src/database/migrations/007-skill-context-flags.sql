-- Migration 007: Explicit context flags on skills
-- Replaces schedule-based inference for needsHistory and needsMemory.
-- Each skill now explicitly declares what context it needs at execution time.

ALTER TABLE skills ADD COLUMN needs_history BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE skills ADD COLUMN needs_memory  BOOLEAN NOT NULL DEFAULT true;
