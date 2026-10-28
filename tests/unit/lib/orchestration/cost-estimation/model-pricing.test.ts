/**
 * Unit Tests: isModelPriced
 *
 * "Priced" must mean what runtime `calculateCost` means: the registry knows
 * the model and nothing marked it `pricingUnknown`. A free model is priced.
 *
 * @see lib/orchestration/cost-estimation/model-pricing.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  getModel: vi.fn(),
}));

import { getModel } from '@/lib/orchestration/llm/model-registry';
import { isModelPriced } from '@/lib/orchestration/cost-estimation/model-pricing';

function model(overrides: Partial<ModelInfo>): ModelInfo {
  return {
    id: 'm',
    name: 'm',
    provider: 'acme',
    tier: 'mid',
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    maxContext: 8_000,
    supportsTools: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isModelPriced', () => {
  it.each([
    ['a model with a positive rate', model({ inputCostPerMillion: 3, outputCostPerMillion: 15 })],
    ['a local-tier model at 0', model({ tier: 'local' })],
    ['a model priced at an explicit 0', model({})],
  ])('is true for %s', (_label, entry) => {
    vi.mocked(getModel).mockReturnValue(entry);
    expect(isModelPriced('m')).toBe(true);
  });

  it('is false for a model marked pricingUnknown', () => {
    vi.mocked(getModel).mockReturnValue(model({ pricingUnknown: true }));
    expect(isModelPriced('m')).toBe(false);
  });

  it('is false for a model the registry lacks', () => {
    vi.mocked(getModel).mockReturnValue(undefined);
    expect(isModelPriced('missing')).toBe(false);
    expect(getModel).toHaveBeenCalledWith('missing');
  });
});
