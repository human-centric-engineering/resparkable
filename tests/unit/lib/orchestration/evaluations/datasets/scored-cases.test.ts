/**
 * Tests: lib/orchestration/evaluations/datasets/scored-cases.ts (§115 t-803)
 *
 * The cases behind a set of case results, read through the dataset's
 * visibility — the read that replaces `include: { datasetCase }`, which the
 * owner layer refuses for a narrowed caller.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { aiDatasetCase: { findMany: vi.fn() } },
}));

import { prisma } from '@/lib/db/client';
import { loadScoredCases } from '@/lib/orchestration/evaluations/datasets/scored-cases';

const VISIBLE = { userId: 'cmuser0000000000000000me01' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadScoredCases', () => {
  it('reads each case once, narrowed to the datasets the caller may see, keyed by id', async () => {
    vi.mocked(prisma.aiDatasetCase.findMany).mockResolvedValue([
      { id: 'c1', input: 'q1', expectedOutput: 'a1', metadata: null },
    ] as never);

    const cases = await loadScoredCases(['c1', 'c2', 'c1'], VISIBLE);

    expect(prisma.aiDatasetCase.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1', 'c2'] }, dataset: VISIBLE },
      select: { id: true, input: true, expectedOutput: true, metadata: true },
    });
    expect(cases.get('c1')).toEqual({ input: 'q1', expectedOutput: 'a1', metadata: null });
    // A case whose dataset the caller can no longer see is simply absent.
    expect(cases.has('c2')).toBe(false);
  });

  it('asks nothing for no results', async () => {
    const cases = await loadScoredCases([], VISIBLE);

    expect(cases.size).toBe(0);
    expect(prisma.aiDatasetCase.findMany).not.toHaveBeenCalled();
  });
});
