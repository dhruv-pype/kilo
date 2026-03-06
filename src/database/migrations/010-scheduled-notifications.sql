-- Migration 010: Scheduled notification persistence
-- Stores recurring notification jobs so they survive server restarts.
-- One-time notifications that are within setTimeout range fire in-process
-- without DB persistence. Recurring ones (cron) are stored here.

CREATE TABLE scheduled_notifications (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id          UUID NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  user_id         UUID NOT NULL,
  session_id      TEXT NOT NULL,
  message         TEXT NOT NULL,
  schedule        TEXT NOT NULL,        -- cron expression
  status          TEXT NOT NULL DEFAULT 'active',  -- active | cancelled
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_at     TIMESTAMPTZ
);

CREATE INDEX idx_scheduled_notifications_bot_id ON scheduled_notifications(bot_id);
CREATE INDEX idx_scheduled_notifications_active  ON scheduled_notifications(status)
  WHERE status = 'active';
