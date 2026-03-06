import { query } from '../pool.js';

export interface ScheduledNotification {
  notificationId: string;
  botId: string;
  userId: string;
  sessionId: string;
  message: string;
  schedule: string;
  status: 'active' | 'cancelled';
  createdAt: Date;
  lastRunAt: Date | null;
}

export async function insertNotification(
  botId: string,
  userId: string,
  sessionId: string,
  message: string,
  schedule: string,
): Promise<string> {
  const result = await query<{ notification_id: string }>(
    `INSERT INTO scheduled_notifications (bot_id, user_id, session_id, message, schedule)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING notification_id`,
    [botId, userId, sessionId, message, schedule],
  );
  return result.rows[0].notification_id;
}

export async function getActiveNotifications(): Promise<ScheduledNotification[]> {
  const result = await query<{
    notification_id: string;
    bot_id: string;
    user_id: string;
    session_id: string;
    message: string;
    schedule: string;
    status: string;
    created_at: Date;
    last_run_at: Date | null;
  }>(
    `SELECT notification_id, bot_id, user_id, session_id, message, schedule, status, created_at, last_run_at
     FROM scheduled_notifications
     WHERE status = 'active'
     ORDER BY created_at`,
    [],
  );
  return result.rows.map((r) => ({
    notificationId: r.notification_id,
    botId: r.bot_id,
    userId: r.user_id,
    sessionId: r.session_id,
    message: r.message,
    schedule: r.schedule,
    status: r.status as 'active' | 'cancelled',
    createdAt: r.created_at,
    lastRunAt: r.last_run_at,
  }));
}

export async function markNotificationFired(notificationId: string): Promise<void> {
  await query(
    `UPDATE scheduled_notifications SET last_run_at = now() WHERE notification_id = $1`,
    [notificationId],
  );
}

export async function cancelNotification(notificationId: string): Promise<void> {
  await query(
    `UPDATE scheduled_notifications SET status = 'cancelled' WHERE notification_id = $1`,
    [notificationId],
  );
}
