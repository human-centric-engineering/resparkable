'use client';

/**
 * GoalsTab — the launcher-opened counterpart to `app/(resparkable)/resparkable/goals/page.tsx`.
 *
 * The server page also fetches `getSparkeyPronoun()` for `GoalsView`'s copy —
 * a server-only helper (reads `next/headers` transitively) with no client
 * equivalent. `pronoun` is optional on `GoalsViewProps` with a safe default
 * (`DEFAULT_SPARKEY_PRONOUN`), so this omits it rather than adding a second
 * client fetch for what is purely a cosmetic wording choice.
 */

import * as React from 'react';
import { z } from 'zod';

import { GoalsView } from '@/components/resparkable/goals/goals-view';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { areaSchema, goalSchema } from '@/lib/framework/resparkable/ui/payloads';

const goalsSchema = z.array(goalSchema);
const areasSchema = z.array(areaSchema);

export function GoalsTab(): React.ReactElement {
  const [goals, retryGoals] = useTabFetch(`${RESPARKABLE_API.GOALS}?limit=200`, goalsSchema);
  const [areas] = useTabFetch(`${RESPARKABLE_API.AREAS}?limit=200`, areasSchema);

  if (goals.status === 'loading') return <SkeletonList label="Loading goals" />;
  if (goals.status === 'error') {
    return <TabLoadError what="your goals" message={goals.message} onRetry={retryGoals} />;
  }

  return <GoalsView goals={goals.data} areas={areas.status === 'ready' ? areas.data : []} />;
}
