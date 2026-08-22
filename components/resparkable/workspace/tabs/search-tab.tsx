'use client';

/**
 * SearchTab — the launcher-opened counterpart to `app/(resparkable)/resparkable/search/page.tsx`.
 *
 * `query` comes from the tab's params, set by whoever opened it (the app
 * header's search box, Phase 6) rather than the URL — search has no
 * meaningful "current route" to fall back on, since every search is opened as
 * its own tab.
 *
 * `includeArchived` now lives in the tab's params too, and the checkbox
 * writes it back through `setTabParams`. It used to be hard-coded `false`
 * here with `SearchControls` left to push the real URL, which meant ticking
 * the box in a Search tab navigated the address bar and changed nothing on
 * screen. Ticking it re-runs the query against the keyword-only archived
 * corpus, which is a second paid embedding call — the same cost the real page
 * pays for the same interaction, and the reason neither debounces.
 */

import * as React from 'react';
import { Search } from 'lucide-react';

import { SearchControls } from '@/components/resparkable/search/search-controls';
import { SearchResults } from '@/components/resparkable/search/search-results';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { searchHitsSchema } from '@/lib/framework/resparkable/ui/payloads';

export interface SearchTabProps {
  /** This tab's id — what `setTabParams` writes the include-archived flag back through. */
  tabId: string;
  query?: string;
  includeArchived: boolean;
}

export function SearchTab({ tabId, query, includeArchived }: SearchTabProps): React.ReactElement {
  const { setTabParams } = useWorkspace();
  const trimmed = query?.trim() ?? '';

  const search = new URLSearchParams({ q: trimmed });
  if (includeArchived) search.set('includeArchived', 'true');
  const endpoint = trimmed ? `${RESPARKABLE_API.SEARCH}?${search.toString()}` : null;

  const [state, retry] = useTabFetch(endpoint, searchHitsSchema);

  const onIncludeArchivedChange = React.useCallback(
    // `undefined` rather than `false` when unticked: `setTabParams` merges,
    // and clearing the key keeps this tab's params equal to a freshly opened
    // one's, so the two still dedupe against each other.
    (next: boolean) => setTabParams(tabId, { includeArchived: next || undefined }),
    [setTabParams, tabId]
  );

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
      <SearchControls
        query={trimmed}
        includeArchived={includeArchived}
        onIncludeArchivedChange={onIncludeArchivedChange}
      />
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
