'use client';

/**
 * AreasTab — the launcher-opened counterpart to `app/(resparkable)/resparkable/areas/page.tsx`.
 *
 * `pronoun` omitted — see `GoalsTab`'s header comment; same reasoning
 * applies here.
 */

import * as React from 'react';
import { z } from 'zod';

import { AreasView } from '@/components/resparkable/areas/areas-view';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { areaSchema } from '@/lib/framework/resparkable/ui/payloads';

const areasSchema = z.array(areaSchema);

export function AreasTab(): React.ReactElement {
  const [areas, retry] = useTabFetch(`${RESPARKABLE_API.AREAS}?limit=200`, areasSchema);

  if (areas.status === 'loading') return <SkeletonList label="Loading life areas" />;
  if (areas.status === 'error') {
    return <TabLoadError what="your life areas" message={areas.message} onRetry={retry} />;
  }
  return <AreasView areas={areas.data} />;
}
