'use client';

/**
 * EntitiesTab — the launcher-opened counterpart to `app/(resparkable)/resparkable/entities/page.tsx`.
 */

import * as React from 'react';
import { z } from 'zod';

import { EntitiesView } from '@/components/resparkable/entities/entities-view';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { entitySchema } from '@/lib/framework/resparkable/ui/payloads';

const entitiesSchema = z.array(entitySchema);

export function EntitiesTab(): React.ReactElement {
  const [entities, retry] = useTabFetch(`${RESPARKABLE_API.ENTITIES}?limit=200`, entitiesSchema);

  if (entities.status === 'loading') return <SkeletonList label="Loading people and companies" />;
  if (entities.status === 'error') {
    return (
      <TabLoadError what="your people and companies" message={entities.message} onRetry={retry} />
    );
  }
  return <EntitiesView entities={entities.data} />;
}
