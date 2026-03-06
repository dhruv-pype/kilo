-- Migration 009: Skill refinement pipeline
-- Stores pending LLM-generated skill improvements awaiting user confirmation.

CREATE TABLE skill_refinements (
  refinement_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id       UUID NOT NULL REFERENCES skills(skill_id) ON DELETE CASCADE,
  bot_id         UUID NOT NULL,
  refinement_data JSONB NOT NULL,   -- SkillRefinementResult
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | applied | dismissed
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '24 hours'
);

CREATE INDEX idx_skill_refinements_skill_id ON skill_refinements(skill_id);
CREATE INDEX idx_skill_refinements_pending  ON skill_refinements(status)
  WHERE status = 'pending';
