import { query } from '../pool.js';
import type { SkillRefinementResult, StoredRefinement } from '../../common/types/orchestrator.js';

export async function saveRefinement(
  skillId: string,
  botId: string,
  result: SkillRefinementResult,
): Promise<string> {
  const res = await query<{ refinement_id: string }>(
    `INSERT INTO skill_refinements (skill_id, bot_id, refinement_data)
     VALUES ($1, $2, $3)
     RETURNING refinement_id`,
    [skillId, botId, JSON.stringify(result)],
  );
  return res.rows[0].refinement_id;
}

export async function getRefinement(refinementId: string): Promise<StoredRefinement | null> {
  const res = await query<{
    refinement_id: string;
    skill_id: string;
    bot_id: string;
    refinement_data: SkillRefinementResult;
    status: string;
  }>(
    `SELECT refinement_id, skill_id, bot_id, refinement_data, status
     FROM skill_refinements
     WHERE refinement_id = $1 AND expires_at > now()`,
    [refinementId],
  );

  if (res.rows.length === 0) return null;
  const row = res.rows[0];

  return {
    refinementId: row.refinement_id,
    skillId: row.skill_id,
    botId: row.bot_id,
    result: row.refinement_data,
  };
}

export async function updateRefinementStatus(
  refinementId: string,
  status: 'applied' | 'dismissed',
): Promise<void> {
  await query(
    `UPDATE skill_refinements SET status = $2 WHERE refinement_id = $1`,
    [refinementId, status],
  );
}
