-- Row-Level Security: tenant isolation via app.current_user_id session variable.
--
-- The application sets `app.current_user_id` (via set_config) before every API query.
-- RLS policies ensure users can only access rows belonging to their bots.
--
-- The table owner (kilo DB user) is exempt from RLS by default.
-- This is intentional — CLI, migrations, and the scheduler's startup query
-- run without user context and bypass RLS.

-- ─── Enable RLS on all tenant-scoped tables ──────────────────

ALTER TABLE bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_proposals ENABLE ROW LEVEL SECURITY;

-- ─── Bots: user can only see their own bots ──────────────────

CREATE POLICY bots_tenant_isolation ON bots
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

-- ─── Skills: user can only see skills belonging to their bots ─

CREATE POLICY skills_tenant_isolation ON skills
  FOR ALL
  USING (bot_id IN (
    SELECT bot_id FROM bots
    WHERE user_id = current_setting('app.current_user_id', true)::uuid
  ));

-- ─── Messages: same pattern ──────────────────────────────────

CREATE POLICY messages_tenant_isolation ON messages
  FOR ALL
  USING (bot_id IN (
    SELECT bot_id FROM bots
    WHERE user_id = current_setting('app.current_user_id', true)::uuid
  ));

-- ─── Memory Facts: same pattern ──────────────────────────────

CREATE POLICY memory_facts_tenant_isolation ON memory_facts
  FOR ALL
  USING (bot_id IN (
    SELECT bot_id FROM bots
    WHERE user_id = current_setting('app.current_user_id', true)::uuid
  ));

-- ─── Skill Proposals: same pattern ───────────────────────────

CREATE POLICY skill_proposals_tenant_isolation ON skill_proposals
  FOR ALL
  USING (bot_id IN (
    SELECT bot_id FROM bots
    WHERE user_id = current_setting('app.current_user_id', true)::uuid
  ));
