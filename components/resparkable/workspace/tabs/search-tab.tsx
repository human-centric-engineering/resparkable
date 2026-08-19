'use client';

/**
 * SearchTab — the launcher-opened counterpart to `app/(protected)/resparkable/search/page.tsx`.
 *
 * `query` comes from the tab's params, set by whoever opened it (the app
 * header's search box, Phase 6) rather than the URL — unlike
 * `PlanTab`/`ProjectsTab`, search has no meaningful "current route" to fall
 * back on, since every search is opened as its own tab. `TabParams`
 * (`tab-registry.ts`) has no `includeArchived` field, so this always starts
 * `false` — `SearchResults`' own checkbox for it is left unmodified, same
 * "the view keeps its own router-based control" quirk as `ProjectsView`'s
 * status filter.
 */

import * as React from 'react';
import { Search } from 'lucide-react';

import { SearchControls } from '@/components/resparkable/search/search-controls';
import { SearchResults } from '@/components/resparkable/search/search-results';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { searchHitsSchema } from '@/lib/framework/resparkable/ui/payloads';

export interface SearchTabProps {
  query?: string;
}

export function SearchTab({ query }: SearchTabProps): React.ReactElement {
  const trimmed = query?.trim() ?? '';
  const includeArchived = false;

  const endpoint = trimmed
    ? `${RESPARKABLE_API.SEARCH}?${new URLSearchParams({ q: trimmed })}`
    : null;

  const [state, retry] = useTabFetch(endpoint, searchHitsSchema);

  if (!trimmed) {
    return (
      <EmptyState
        icon={Search}
        title="Search your material"
        description="Notes, projects, goals, areas, people and documents, matched by meaning."
      />
    );
  }

  return (
    <div className="space-y-4 p-4">
      <SearchControls query={trimmed} />
      {state.status === 'loading' && <SkeletonList label="Searching" />}
      {state.status === 'error' && (
        <TabLoadError what="your search" message={state.message} onRetry={retry} />
      )}
      {state.status === 'ready' && (
        <SearchResults query={trimmed} hits={state.data} includeArchived={includeArchived} />
      )}
    </div>
  );
}
