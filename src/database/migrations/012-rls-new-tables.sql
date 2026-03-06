-- Migration 012: RLS for tables added after the initial RLS migration.
-- skill_refinements, scheduled_notifications, and document_chunks were
-- created without row-level security. This closes that gap.

-- ─── Skill Refinements ────────────────────────────────────────────

ALTER TABLE skill_refinements ENABLE ROW LEVEL SECURITY;

CREATE POLICY skill_refinements_tenant_isolation ON skill_refinements
  FOR ALL
  USING (bot_id IN (
    SELECT bot_id FROM bots
    WHERE user_id = current_setting('app.current_user_id', true)::uuid
  ));

-- ─── Scheduled Notifications ──────────────────────────────────────
-- Has user_id directly, so the policy is simpler.

ALTER TABLE scheduled_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY scheduled_notifications_tenant_isolation ON scheduled_notifications
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

-- ─── Document Chunks ──────────────────────────────────────────────

ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY document_chunks_tenant_isolation ON document_chunks
  FOR ALL
  USING (bot_id IN (
    SELECT bot_id FROM bots
    WHERE user_id = current_setting('app.current_user_id', true)::uuid
  ));
