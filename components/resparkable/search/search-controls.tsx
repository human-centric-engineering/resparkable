'use client';

/**
 * SearchControls — the filters on the results page.
 *
 * Every change navigates rather than re-querying in place, because each query is a
 * paid embedding call: `searchResparkable` embeds the text before it can rank anything,
 * which is why the endpoint carries its own 30/min sub-cap and is deliberately not
 * ETag'd. Filters therefore behave like a new search, and the URL stays the single
 * source of truth for what is on screen — shareable, back-button-correct, and
 * impossible to get out of step with the results below it.
 *
 * `includeArchived` is the one filter with a consequence worth stating: the
 * archived corpus has no embeddings by design, so ticking it adds a keyword-only
 * pass rather than widening the semantic one.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { Checkbox } from '@/components/ui/checkbox';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import { withActiveSpace } from '@/lib/framework/resparkable/api/client';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

export interface SearchControlsProps {
  query: string;
  /**
   * Whether the archived corpus is currently included. Absent on the real
   * page, which reads it off the URL itself — a launcher-opened `SearchTab`
   * passes its own tab-scoped value, because two Search panes reading one
   * `useSearchParams()` meant ticking the box in either ticked both.
   */
  includeArchived?: boolean;
  /** Where a change goes. Absent, it navigates, exactly as this header describes. */
  onIncludeArchivedChange?: (includeArchived: boolean) => void;
}

export function SearchControls({
  query,
  includeArchived: includeArchivedProp,
  onIncludeArchivedChange,
}: SearchControlsProps): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const includeArchived = includeArchivedProp ?? params.get('includeArchived') === 'true';

  function setIncludeArchived(next: boolean): void {
    if (onIncludeArchivedChange) {
      onIncludeArchivedChange(next);
      return;
    }
    const search = new URLSearchParams(params.toString());
    search.set('q', query);
    if (next) {
      search.set('includeArchived', 'true');
    } else {
      search.delete('includeArchived');
    }
    router.push(withActiveSpace(`${RESPARKABLE_ROUTES.SEARCH}?${search.toString()}`));
  }

  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id="resparkable-search-archived"
        checked={includeArchived}
        onCheckedChange={(checked) => setIncludeArchived(checked === true)}
      />
      <Label htmlFor="resparkable-search-archived" className="flex items-center gap-1.5 text-sm">
        Include archived
        <FieldHelp title="Archived items">
          <p>
            Archiving removes an item&rsquo;s embeddings, so the archive is searched by wording
            rather than by meaning. That keeps the meaning-search accurate as your history grows
            instead of slowly getting noisier.
          </p>
        </FieldHelp>
      </Label>
    </div>
  );
}
