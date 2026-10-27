/**
 * Whether a cost estimate can price a model — shared by the workflow and
 * evaluation estimators so both answer the same way, and the same way the
 * runtime does.
 */

import { getModel } from '@/lib/orchestration/llm/model-registry';

/**
 * A model is "priced" when the registry knows it and something has supplied
 * its rate — the same test `calculateCost` applies. A free model (a local
 * provider, or a matrix row priced at an explicit 0) is priced at $0, not
 * unknown: runtime records its turns as free, so the estimate must too.
 * Only a registry miss, or an entry marked `pricingUnknown`, is unpriced.
 */
export function isModelPriced(modelId: string): boolean {
  const model = getModel(modelId);
  return model !== undefined && model.pricingUnknown !== true;
}
