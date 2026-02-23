import { describe, it, expect } from 'vitest';
import { fastMatch } from '@bot-runtime/skill-matcher/fast-matcher.js';
import type { SkillDefinition } from '@common/types/skill.js';
import type { BotId, SkillId } from '@common/types/ids.js';

function makeSkill(name: string, patterns: string[]): SkillDefinition {
  return {
    skillId: `skill-${name}` as SkillId,
    botId: 'bot-123' as BotId,
    name,
    description: `${name} skill`,
    triggerPatterns: patterns,
    behaviorPrompt: `Handle ${name} requests`,
    inputSchema: null,
    outputFormat: 'text',
    schedule: null,
    dataTable: null,
    readableTables: [],
    tableSchema: null,
    requiredIntegrations: [],
    createdBy: 'user_conversation',
    version: 1,
    performanceScore: 0.5,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('fastMatch', () => {
  const orderTracker = makeSkill('Order Tracker', [
    'new order',
    'add order',
    'what orders do I have',
    'show orders this week',
  ]);

  const salesLog = makeSkill('Sales Log', [
    'log sales',
    'record sales today',
    'daily sales total',
  ]);

  const reminderSkill = makeSkill('Reminder', [
    'remind me',
    'set reminder',
    'don\'t forget',
  ]);

  const allSkills = [orderTracker, salesLog, reminderSkill];

  it('matches "new order" to Order Tracker', () => {
    const result = fastMatch('new order for Maria', allSkills);
    expect(result).not.toBeNull();
    expect(result!.skill.name).toBe('Order Tracker');
  });

  it('matches "remind me" to Reminder', () => {
    const result = fastMatch('remind me to call the supplier at 3pm', allSkills);
    expect(result).not.toBeNull();
    expect(result!.skill.name).toBe('Reminder');
  });

  it('matches "log sales" to Sales Log', () => {
    const result = fastMatch('log sales for today: $450', allSkills);
    expect(result).not.toBeNull();
    expect(result!.skill.name).toBe('Sales Log');
  });

  it('matches "what orders" to Order Tracker', () => {
    const result = fastMatch('what orders do I have this week?', allSkills);
    expect(result).not.toBeNull();
    expect(result!.skill.name).toBe('Order Tracker');
  });

  it('returns null for unrelated messages', () => {
    const result = fastMatch('how is the weather today?', allSkills);
    expect(result).toBeNull();
  });

  it('returns null for empty message', () => {
    const result = fastMatch('', allSkills);
    expect(result).toBeNull();
  });

  it('returns null for empty skills list', () => {
    const result = fastMatch('new order for Maria', []);
    expect(result).toBeNull();
  });

  it('skips inactive skills', () => {
    const inactive = makeSkill('Inactive', ['new order']);
    inactive.isActive = false;
    const result = fastMatch('new order', [inactive]);
    expect(result).toBeNull();
  });

  it('picks the best match when multiple skills could apply', () => {
    const orderReminder = makeSkill('Order Reminder', [
      'remind me about orders',
      'order reminder',
    ]);
    const result = fastMatch('new order for tomorrow', [...allSkills, orderReminder]);
    // "new order" is a direct match for Order Tracker
    expect(result).not.toBeNull();
    expect(result!.skill.name).toBe('Order Tracker');
  });

  it('handles messages with extra context gracefully', () => {
    const result = fastMatch(
      'Hey, I need to add a new order please. Maria wants a chocolate cake for Saturday.',
      allSkills,
    );
    expect(result).not.toBeNull();
    expect(result!.skill.name).toBe('Order Tracker');
  });

  it('returns a confidence score between 0 and 1', () => {
    const result = fastMatch('new order', allSkills);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThan(0);
    expect(result!.confidence).toBeLessThanOrEqual(1);
  });
});
