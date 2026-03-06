-- Add proposal_data JSONB to skill_proposals so we can recreate the skill on acceptance.
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS proposal_data JSONB;
