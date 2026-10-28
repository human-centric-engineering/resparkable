/**
 * The dataset cases behind a set of case results, read through the dataset's
 * visibility (§115 t-803).
 *
 * A case result reaches its case through a to-one relation, and a case's
 * owner is its dataset's. The owner layer (`lib/db/owner-extension.ts`) can
 * check a to-one on the row it returns only when that row carries its own
 * owner column, so it refuses `include: { datasetCase }` for a narrowed
 * caller. Callers read the results first, confined to runs they may read, and
 * the cases here, narrowed to the datasets `datasetWhere` admits — usually
 * `datasetVisibilityWhere(session)`.
 *
 * So a run made from a dataset another member has since claimed keeps its
 * scores and outputs, and its cases come back absent: the run's record does
 * not carry the content of a dataset that is now someone else's.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';

/** What a case result shows of the case it scored. */
export interface ScoredCase {
  input: Prisma.JsonValue;
  expectedOutput: string | null;
  metadata: Prisma.JsonValue;
}

/** The cases with these ids in datasets `datasetWhere` admits, by id. */
export async function loadScoredCases(
  caseIds: readonly string[],
  datasetWhere: Prisma.AiDatasetWhereInput
): Promise<Map<string, ScoredCase>> {
  if (caseIds.length === 0) return new Map();
  const rows = await prisma.aiDatasetCase.findMany({
    where: { id: { in: [...new Set(caseIds)] }, dataset: datasetWhere },
    select: { id: true, input: true, expectedOutput: true, metadata: true },
  });
  return new Map(
    rows.map((r) => [
      r.id,
      { input: r.input, expectedOutput: r.expectedOutput, metadata: r.metadata },
    ])
  );
}
