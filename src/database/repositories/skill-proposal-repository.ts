import { query } from '../pool.js';
import type { SkillProposal, StoredProposal } from '../../common/types/orchestrator.js';

export async function insertProposal(
  botId: string,
  proposalId: string,
  proposal: SkillProposal,
): Promise<void> {
  await query(
    `INSERT INTO skill_proposals (proposal_id, bot_id, proposed_name, description, proposal_data)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (proposal_id) DO NOTHING`,
    [proposalId, botId, proposal.proposedName, proposal.description, JSON.stringify(proposal)],
  );
}

export async function getRecentDismissals(
  botId: string,
): Promise<{ proposedName: string; dismissedAt: Date }[]> {
  const result = await query<{ proposed_name: string; dismissed_at: Date }>(
    `SELECT proposed_name, dismissed_at
     FROM skill_proposals
     WHERE bot_id = $1
       AND status = 'dismissed'
       AND dismissed_at > now() - interval '7 days'`,
    [botId],
  );
  return result.rows.map((r) => ({
    proposedName: r.proposed_name,
    dismissedAt: r.dismissed_at,
  }));
}

export async function updateProposalStatus(
  proposalId: string,
  status: 'accepted' | 'dismissed',
): Promise<void> {
  await query(
    `UPDATE skill_proposals
     SET status = $2,
         dismissed_at = CASE WHEN $2 = 'dismissed' THEN now() ELSE dismissed_at END
     WHERE proposal_id = $1`,
    [proposalId, status],
  );
}

export async function getProposal(proposalId: string): Promise<StoredProposal | null> {
  const result = await query<{ proposal_id: string; bot_id: string; proposal_data: SkillProposal | null }>(
    `SELECT proposal_id, bot_id, proposal_data
     FROM skill_proposals
     WHERE proposal_id = $1`,
    [proposalId],
  );
  if (result.rows.length === 0 || !result.rows[0].proposal_data) return null;
  return {
    proposalId: result.rows[0].proposal_id,
    botId: result.rows[0].bot_id,
    proposal: result.rows[0].proposal_data,
  };
}
