import { describe, it, expect } from 'vitest';
import { calculateCost } from '../../../src/llm-gateway/usage-tracker.js';
import type { ModelPricing } from '../../../src/common/types/usage.js';

/**
 * Tests for calculateCost — the pure function that turns
 * token counts + pricing into a dollar amount.
 *
 * This is the most critical calculation in cost tracking.
 * If this is wrong, users see incorrect spend in their iOS app.
 */

const sonnetPricing: ModelPricing = {
  model: 'claude-sonnet-4-5-20250929',
  provider: 'anthropic',
  inputCostPerMillionTokens: 3.00,
  outputCostPerMillionTokens: 15.00,
};

const haikuPricing: ModelPricing = {
  model: 'claude-haiku-4-5-20251001',
  provider: 'anthropic',
  inputCostPerMillionTokens: 0.80,
  outputCostPerMillionTokens: 4.00,
};

const gpt4oPricing: ModelPricing = {
  model: 'gpt-4o',
  provider: 'openai',
  inputCostPerMillionTokens: 2.50,
  outputCostPerMillionTokens: 10.00,
};

describe('calculateCost', () => {
  it('calculates cost correctly for Sonnet', () => {
    // 1000 prompt tokens at $3/M = $0.003
    // 500 completion tokens at $15/M = $0.0075
    // Total = $0.0105
    const cost = calculateCost(1000, 500, sonnetPricing);
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it('calculates cost correctly for Haiku', () => {
    // 2000 prompt tokens at $0.80/M = $0.0016
    // 1000 completion tokens at $4/M = $0.004
    // Total = $0.0056
    const cost = calculateCost(2000, 1000, haikuPricing);
    expect(cost).toBeCloseTo(0.0056, 6);
  });

  it('calculates cost correctly for GPT-4o', () => {
    // 5000 prompt tokens at $2.50/M = $0.0125
    // 2000 completion tokens at $10/M = $0.02
    // Total = $0.0325
    const cost = calculateCost(5000, 2000, gpt4oPricing);
    expect(cost).toBeCloseTo(0.0325, 6);
  });

  it('returns 0 for zero tokens', () => {
    const cost = calculateCost(0, 0, sonnetPricing);
    expect(cost).toBe(0);
  });

  it('handles prompt-only calls (0 completion tokens)', () => {
    const cost = calculateCost(1000, 0, sonnetPricing);
    expect(cost).toBeCloseTo(0.003, 6);
  });

  it('handles large token counts without floating-point issues', () => {
    // 1M prompt tokens at $3/M = $3.00
    // 500K completion tokens at $15/M = $7.50
    // Total = $10.50
    const cost = calculateCost(1_000_000, 500_000, sonnetPricing);
    expect(cost).toBe(10.5);
  });

  it('rounds to 6 decimal places', () => {
    // 1 prompt token at $3/M = $0.000003
    // 1 completion token at $15/M = $0.000015
    // Total = $0.000018
    const cost = calculateCost(1, 1, sonnetPricing);
    expect(cost).toBe(0.000018);
  });

  it('handles Opus-level expensive models', () => {
    const opusPricing: ModelPricing = {
      model: 'claude-opus-4-6',
      provider: 'anthropic',
      inputCostPerMillionTokens: 15.00,
      outputCostPerMillionTokens: 75.00,
    };
    // 10000 prompt tokens at $15/M = $0.15
    // 5000 completion tokens at $75/M = $0.375
    // Total = $0.525
    const cost = calculateCost(10000, 5000, opusPricing);
    expect(cost).toBeCloseTo(0.525, 6);
  });
});
