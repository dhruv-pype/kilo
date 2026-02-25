import { v4 as uuidv4 } from 'uuid';
import { query } from '../pool.js';
import type { Message, UserMessage } from '../../common/types/message.js';
import { messageId } from '../../common/types/ids.js';
import type { BotId, MessageId, SessionId } from '../../common/types/ids.js';

// UUID v4 format check — built-in skill IDs like "builtin-time" aren't valid UUIDs
// and can't be stored in the messages.skill_id column (UUID FK → skills table).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function insertMessage(msg: {
  sessionId: string;
  botId: string;
  role: string;
  content: string;
  attachments?: unknown[];
  skillId?: string | null;
}): Promise<Message> {
  const id = uuidv4();
  // Only persist skill_id if it's a real UUID (user-created skills).
  // Built-in skill IDs (e.g. "builtin-time") are not in the skills table.
  const persistableSkillId = msg.skillId && UUID_RE.test(msg.skillId) ? msg.skillId : null;
  const result = await query<MessageRow>(
    `INSERT INTO messages (message_id, session_id, bot_id, role, content, attachments, skill_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      id,
      msg.sessionId,
      msg.botId,
      msg.role,
      msg.content,
      JSON.stringify(msg.attachments ?? []),
      persistableSkillId,
    ],
  );

  return mapMessageRow(result.rows[0]);
}

/**
 * Get recent messages for a bot, ordered newest-first.
 * Used by the Orchestrator for conversation history loading.
 * The `limit` parameter is driven by ContextRequirements.historyDepth (Spec #4).
 */
export async function getRecentMessages(
  botIdValue: string,
  sessionId: string,
  limit: number,
): Promise<Message[]> {
  const result = await query<MessageRow>(
    `SELECT * FROM messages
     WHERE bot_id = $1 AND session_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [botIdValue, sessionId, limit],
  );

  // Reverse so messages are in chronological order (oldest first)
  return result.rows.reverse().map(mapMessageRow);
}

/**
 * Count messages for a bot in a given time period.
 * Used for tier limit enforcement.
 */
export async function countMessagesInPeriod(
  botIdValue: string,
  since: Date,
): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM messages
     WHERE bot_id = $1 AND role = 'user' AND created_at >= $2`,
    [botIdValue, since],
  );
  return parseInt(result.rows[0].count, 10);
}

// ─── Internal ──────────────────────────────────────────────────

interface MessageRow {
  message_id: string;
  session_id: string;
  bot_id: string;
  role: string;
  content: string;
  attachments: unknown[];
  skill_id: string | null;
  created_at: Date;
}

function mapMessageRow(row: MessageRow): Message {
  return {
    messageId: messageId(row.message_id),
    sessionId: row.session_id as SessionId,
    botId: row.bot_id as BotId,
    role: row.role as Message['role'],
    content: row.content,
    attachments: (row.attachments ?? []) as Message['attachments'],
    skillId: row.skill_id,
    timestamp: row.created_at,
  };
}
