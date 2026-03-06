import { describe, it, expect } from 'vitest';
import {
  buildRefinementMarker,
  buildSkillExecMarker,
  detectRefinementFollowUp,
  detectPostExecutionFeedback,
  detectSkillRefinementIntent,
  REFINEMENT_MARKER,
  SKILL_EXEC_MARKER,
} from '../../../src/web-research/learning-detector.js';
import type { SkillDefinition } from '@common/types/skill.js';
import type { BotId, SkillId } from '@common/types/ids.js';

// ─── Fixtures ──────────────────────────────────────────────────

function makeSkill(name: string, id = 'skill-123'): SkillDefinition {
  return {
    skillId: id as SkillId,
    botId: 'bot-1' as BotId,
    name,
    description: `${name} skill`,
    triggerPatterns: ['log steps', 'track steps'],
    behaviorPrompt: '',
    inputSchema: null,
    outputFormat: 'text',
    schedule: null,
    needsHistory: false,
    needsMemory: false,
    dataTable: null,
    readsData: false,
    readableTables: [],
    tableSchema: null,
    requiredIntegrations: [],
    createdBy: 'auto_proposed',
    version: 1,
    performanceScore: 0.5,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ─── Marker builders ───────────────────────────────────────────

describe('buildSkillExecMarker', () => {
  it('builds a skill-exec marker', () => {
    const marker = buildSkillExecMarker('skill-abc');
    expect(marker).toBe('<!-- skill-exec:skill-abc -->');
    expect(marker.startsWith(SKILL_EXEC_MARKER)).toBe(true);
  });
});

describe('buildRefinementMarker', () => {
  it('builds a refinement marker', () => {
    const marker = buildRefinementMarker('refine-xyz');
    expect(marker).toBe('<!-- skill-refine:refine-xyz -->');
    expect(marker.startsWith(REFINEMENT_MARKER)).toBe(true);
  });
});

// ─── detectRefinementFollowUp ──────────────────────────────────

describe('detectRefinementFollowUp', () => {
  const lastMsg = '<!-- skill-refine:ref-001 -->\nHere is what would change: ...';

  it('returns accepted=true for affirmative reply', () => {
    expect(detectRefinementFollowUp('yes', lastMsg)).toEqual({ refinementId: 'ref-001', accepted: true });
    expect(detectRefinementFollowUp('ok apply it', lastMsg)).toEqual({ refinementId: 'ref-001', accepted: true });
    expect(detectRefinementFollowUp("looks good", lastMsg)).toEqual({ refinementId: 'ref-001', accepted: true });
    expect(detectRefinementFollowUp("yes, apply it", lastMsg)).toEqual({ refinementId: 'ref-001', accepted: true });
  });

  it('returns accepted=false for negative reply', () => {
    expect(detectRefinementFollowUp('no', lastMsg)).toEqual({ refinementId: 'ref-001', accepted: false });
    expect(detectRefinementFollowUp('no thanks', lastMsg)).toEqual({ refinementId: 'ref-001', accepted: false });
    expect(detectRefinementFollowUp("nah don't", lastMsg)).toEqual({ refinementId: 'ref-001', accepted: false });
  });

  it('returns null when no refinement marker in last message', () => {
    expect(detectRefinementFollowUp('yes', 'Here is the result.')).toBeNull();
    expect(detectRefinementFollowUp('yes', null)).toBeNull();
  });

  it('returns null for ambiguous replies', () => {
    expect(detectRefinementFollowUp('What are the changes?', lastMsg)).toBeNull();
  });
});

// ─── detectPostExecutionFeedback ──────────────────────────────

describe('detectPostExecutionFeedback', () => {
  const lastMsg = '<!-- skill-exec:skill-abc -->Logged 8000 steps for today.';

  it('detects negative feedback after skill execution', () => {
    expect(detectPostExecutionFeedback("that's wrong", lastMsg)).toEqual({ skillId: 'skill-abc' });
    expect(detectPostExecutionFeedback("that's incorrect", lastMsg)).toEqual({ skillId: 'skill-abc' });
    expect(detectPostExecutionFeedback("wrong", lastMsg)).toEqual({ skillId: 'skill-abc' });
    expect(detectPostExecutionFeedback("no that's not right", lastMsg)).toEqual({ skillId: 'skill-abc' });
    expect(detectPostExecutionFeedback("fix this", lastMsg)).toEqual({ skillId: 'skill-abc' });
  });

  it('returns null when no skill-exec marker in last message', () => {
    expect(detectPostExecutionFeedback("that's wrong", 'Logged 8000 steps.')).toBeNull();
    expect(detectPostExecutionFeedback("that's wrong", null)).toBeNull();
  });

  it('returns null for non-negative messages', () => {
    expect(detectPostExecutionFeedback('great, thanks!', lastMsg)).toBeNull();
    expect(detectPostExecutionFeedback('log 5000 more steps', lastMsg)).toBeNull();
    expect(detectPostExecutionFeedback('show me my steps today', lastMsg)).toBeNull();
  });
});

// ─── detectSkillRefinementIntent ──────────────────────────────

describe('detectSkillRefinementIntent', () => {
  const skills = [
    makeSkill('Step Tracker', 'skill-steps'),
    makeSkill('Expense Tracker', 'skill-expense'),
  ];

  it('detects explicit "fix my X skill" request', () => {
    const result = detectSkillRefinementIntent('fix my step tracker', skills);
    expect(result).not.toBeNull();
    expect(result!.skill.skillId).toBe('skill-steps');
    expect(result!.feedback).toContain('fix my step tracker');
  });

  it('detects "improve my X" request', () => {
    const result = detectSkillRefinementIntent('improve my expense tracker', skills);
    expect(result).not.toBeNull();
    expect(result!.skill.skillId).toBe('skill-expense');
  });

  it('detects "update my X skill" request', () => {
    const result = detectSkillRefinementIntent('update my step tracker to handle yesterday', skills);
    expect(result).not.toBeNull();
    expect(result!.skill.skillId).toBe('skill-steps');
  });

  it('returns null when no skill name matches', () => {
    expect(detectSkillRefinementIntent('fix my calendar', skills)).toBeNull();
    expect(detectSkillRefinementIntent('this is broken', skills)).toBeNull();
  });

  it('returns null with empty skills list', () => {
    expect(detectSkillRefinementIntent('fix my steps skill', [])).toBeNull();
  });

  it('detects "X skill should ..." request', () => {
    const result = detectSkillRefinementIntent('the expense tracker should handle weekly totals', skills);
    expect(result).not.toBeNull();
    expect(result!.skill.skillId).toBe('skill-expense');
  });
});
