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

  // ─── 100% pattern recall: prevents false positives ─────────────

  it('does not match when only some pattern keywords appear (partial overlap)', () => {
    // "what time" pattern should NOT match "what other skills do you have"
    // because "time" is missing from the message
    const timeSkill = makeSkill('Time', ['what time', 'current time']);
    const result = fastMatch('what other skills do you have?', [timeSkill]);
    expect(result).toBeNull();
  });

  it('does not match when message shares only one keyword with pattern', () => {
    // "time now" should NOT match "where am I right now"
    // because "time" is missing — only "now" overlaps
    const timeSkill = makeSkill('Time', ['time now']);
    const result = fastMatch('where am I right now?', [timeSkill]);
    expect(result).toBeNull();
  });

  it('does not match ambiguous single-word messages to multi-keyword patterns', () => {
    // "Day?" should not match "what day is it" because "what" is missing
    const timeSkill = makeSkill('Time', ['what day is it', 'what time']);
    const result = fastMatch('Day?', [timeSkill]);
    expect(result).toBeNull();
  });

  it('matches when ALL pattern keywords appear in the message', () => {
    const timeSkill = makeSkill('Time', ['what time']);
    const result = fastMatch('what time is it in Tokyo?', [timeSkill]);
    expect(result).not.toBeNull();
    expect(result!.skill.name).toBe('Time');
  });

  it('does not match unrelated messages that share common words like "what"', () => {
    const timeSkill = makeSkill('Time', ['what time', 'what date']);
    const dateSkill = makeSkill('Date Math', ['days until', 'how many days']);
    const result = fastMatch('what can you help me with?', [timeSkill, dateSkill]);
    expect(result).toBeNull();
  });
});
