import { describe, it, expect } from 'vitest';
import {
  detectLearningIntent,
  looksLikeServiceName,
  detectClarificationFollowUp,
  buildClarificationMarker,
  CLARIFICATION_MARKER,
} from '../../../src/web-research/learning-detector.js';

describe('detectLearningIntent', () => {
  // ── High confidence patterns ─────────────────────────────────

  describe('explicit learning phrases (confidence 0.95)', () => {
    it('detects "learn how to use X"', () => {
      const result = detectLearningIntent('Learn how to use Canva');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Canva');
      expect(result!.confidence).toBe(0.95);
    });

    it('detects "learn to use X"', () => {
      const result = detectLearningIntent('learn to use Stripe');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Stripe');
      expect(result!.confidence).toBe(0.95);
    });

    it('detects "learn how to work with X"', () => {
      const result = detectLearningIntent('learn how to work with Slack');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Slack');
      expect(result!.confidence).toBe(0.95);
    });

    it('strips trailing "API" from service name', () => {
      const result = detectLearningIntent('learn how to use the Canva API');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Canva');
    });
  });

  describe('integration phrases (confidence 0.9)', () => {
    it('detects "integrate with X"', () => {
      const result = detectLearningIntent('integrate with Stripe');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Stripe');
      expect(result!.confidence).toBe(0.9);
    });

    it('detects "connect to X"', () => {
      const result = detectLearningIntent('connect to Slack');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Slack');
      expect(result!.confidence).toBe(0.9);
    });

    it('detects "connect to the X API"', () => {
      const result = detectLearningIntent('connect to the Notion API');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Notion');
    });

    it('detects "add X integration"', () => {
      const result = detectLearningIntent('add Trello integration');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Trello');
      expect(result!.confidence).toBe(0.9);
    });
  });

  describe('setup phrases (confidence 0.85)', () => {
    it('detects "set up X"', () => {
      const result = detectLearningIntent('set up Notion');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Notion');
      expect(result!.confidence).toBe(0.85);
    });

    it('detects "set up X integration"', () => {
      const result = detectLearningIntent('set up the Slack integration');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Slack');
    });
  });

  describe('implied learning (confidence 0.7-0.75)', () => {
    it('detects "I want you to use X"', () => {
      const result = detectLearningIntent('I want you to use Canva');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Canva');
      expect(result!.confidence).toBe(0.75);
    });

    it('detects "I want you to be able to use X"', () => {
      const result = detectLearningIntent('I want you to be able to use Trello');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Trello');
      expect(result!.confidence).toBe(0.75);
    });

    it('detects "can you use X"', () => {
      const result = detectLearningIntent('can you use Stripe');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Stripe');
      expect(result!.confidence).toBe(0.7);
    });

    it('detects "can you connect to X"', () => {
      const result = detectLearningIntent('can you connect to Notion');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Notion');
      expect(result!.confidence).toBe(0.7);
    });
  });

  // ── Non-learning messages ────────────────────────────────────

  describe('returns null for non-learning messages', () => {
    it('returns null for general questions', () => {
      expect(detectLearningIntent("What's the weather?")).toBeNull();
    });

    it('returns null for skill-like requests', () => {
      expect(detectLearningIntent('New order: Maria, chocolate cake, Saturday')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(detectLearningIntent('')).toBeNull();
    });

    it('returns null for whitespace only', () => {
      expect(detectLearningIntent('   ')).toBeNull();
    });

    it('returns null for casual mention of learning', () => {
      expect(detectLearningIntent('I learned something today')).toBeNull();
    });

    it('returns null for greetings', () => {
      expect(detectLearningIntent('Hello there!')).toBeNull();
    });
  });

  // ── Service name cleanup ─────────────────────────────────────

  describe('service name cleanup', () => {
    it('title-cases service names', () => {
      const result = detectLearningIntent('learn how to use canva');
      expect(result!.serviceName).toBe('Canva');
    });

    it('handles multi-word service names', () => {
      const result = detectLearningIntent('learn how to use google sheets');
      expect(result!.serviceName).toBe('Google Sheets');
    });

    it('strips "integration" suffix', () => {
      const result = detectLearningIntent('add Slack integration');
      expect(result!.serviceName).toBe('Slack');
    });

    it('strips "service" suffix', () => {
      const result = detectLearningIntent('set up the stripe service');
      expect(result!.serviceName).toBe('Stripe');
    });

    it('preserves the original phrase', () => {
      const result = detectLearningIntent('  learn how to use Canva  ');
      expect(result!.originalPhrase).toBe('learn how to use Canva');
    });
  });

  // ── Catch-all pattern ──────────────────────────────────────────

  describe('catch-all "learn (how) to" pattern (confidence 0.6)', () => {
    it('detects "learn how to tell time" at low confidence', () => {
      const result = detectLearningIntent('learn how to tell time');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Tell Time');
      expect(result!.confidence).toBe(0.6);
    });

    it('detects "learn to send emails" at low confidence', () => {
      const result = detectLearningIntent('learn to send emails');
      expect(result).not.toBeNull();
      expect(result!.serviceName).toBe('Send Emails');
      expect(result!.confidence).toBe(0.6);
    });

    it('specific patterns still win over catch-all', () => {
      // "learn how to use Canva" matches the 0.95 pattern, not the catch-all
      const result = detectLearningIntent('learn how to use Canva');
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.95);
    });
  });

  // ── looksLikeServiceName ───────────────────────────────────────

  describe('looksLikeServiceName', () => {
    it('returns true for "Stripe"', () => {
      expect(looksLikeServiceName('Stripe')).toBe(true);
    });

    it('returns true for "Google Sheets"', () => {
      expect(looksLikeServiceName('Google Sheets')).toBe(true);
    });

    it('returns false for "tell time" (starts with verb)', () => {
      expect(looksLikeServiceName('tell time')).toBe(false);
    });

    it('returns false for "send emails to my team automatically" (>4 words)', () => {
      expect(looksLikeServiceName('send emails to my team automatically')).toBe(false);
    });

    it('returns true for short non-verb phrase', () => {
      expect(looksLikeServiceName('Notion')).toBe(true);
    });

    it('returns false for "create reports" (starts with verb)', () => {
      expect(looksLikeServiceName('create reports')).toBe(false);
    });

    it('returns true for "My Custom Tool" (3 words, no verb prefix)', () => {
      expect(looksLikeServiceName('My Custom Tool')).toBe(true);
    });
  });

  // ── detectClarificationFollowUp ────────────────────────────────

  describe('detectClarificationFollowUp', () => {
    const markedMessage = `${buildClarificationMarker('Tell Time')}I can do that! I'll search for an API.`;

    it('detects "yes" as affirmative follow-up', () => {
      const result = detectClarificationFollowUp('Yes', markedMessage);
      expect(result).not.toBeNull();
      expect(result!.searchQuery).toBe('Tell Time API');
    });

    it('detects "sure" as affirmative', () => {
      const result = detectClarificationFollowUp('Sure, go ahead', markedMessage);
      expect(result).not.toBeNull();
      expect(result!.searchQuery).toBe('Tell Time API');
    });

    it('detects "search for it" as affirmative', () => {
      const result = detectClarificationFollowUp('search for it', markedMessage);
      expect(result).not.toBeNull();
      expect(result!.searchQuery).toBe('Tell Time API');
    });

    it('returns null for "no thanks"', () => {
      const result = detectClarificationFollowUp('No thanks', markedMessage);
      expect(result).toBeNull();
    });

    it('returns null for "never mind"', () => {
      const result = detectClarificationFollowUp('Never mind', markedMessage);
      expect(result).toBeNull();
    });

    it('returns null when last message has no marker', () => {
      const result = detectClarificationFollowUp('Yes', 'Just a normal response');
      expect(result).toBeNull();
    });

    it('returns null when last message is null', () => {
      const result = detectClarificationFollowUp('Yes', null);
      expect(result).toBeNull();
    });

    it('picks up service name when user mentions an API', () => {
      const result = detectClarificationFollowUp('try the WorldTimeAPI service', markedMessage);
      expect(result).not.toBeNull();
      expect(result!.searchQuery).toBe('try the WorldTimeAPI service');
    });

    it('uses user reply as search query for short non-negative replies', () => {
      const result = detectClarificationFollowUp('just find a free time API', markedMessage);
      expect(result).not.toBeNull();
      expect(result!.searchQuery).toBe('just find a free time API');
    });
  });

  // ── buildClarificationMarker ───────────────────────────────────

  describe('buildClarificationMarker', () => {
    it('embeds capability in marker', () => {
      const marker = buildClarificationMarker('Tell Time');
      expect(marker).toContain(CLARIFICATION_MARKER);
      expect(marker).toContain('Tell Time');
      expect(marker).toContain('-->');
    });
  });
});
