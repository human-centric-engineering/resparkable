'use client';

/**
 * SharedWithMeView — everything other people have handed you, and nothing of
 * your own.
 *
 * ## Why this list looks different from every other list in the app
 *
 * Every other Resparkable list is a **planning** surface: it shows what you have
 * committed to, ranked. This one deliberately is not. It carries no priority,
 * no scores, no drag handles and no create button, because none of that is
 * yours to arrange. What it does carry, on every row, is **who** shared it —
 * which is the one thing a public link never shows and the reason a named grant
 * exists as a separate mechanism at all.
 *
 * ## Why the search box here is not the app's search box
 *
 * The owner's search is hybrid: a vector query blended with keyword ranking.
 * This one matches substrings in titles and descriptions and cannot do
 * otherwise — the semantic index belongs to the person who owns the items, and
 * reaching into it would put their whole corpus behind a text box on the
 * strength of one shared project. The placeholder says "match words" rather
 * than "search" for that reason: promising more than the mechanism does is how
 * people conclude a feature is broken.
 */

import * as React from 'react';
import { Handshake, Search } from 'lucide-react';

import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { WorkspaceLink } from '@/components/resparkable/workspace/workspace-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import { Input } from '@/components/ui/input';
import { withActiveSpace } from '@/lib/framework/resparkable/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import { useActiveSpaceId } from '@/lib/framework/resparkable/ui/use-active-space';
import {
  sharedOwnerLabel,
  sharedSearchHitsSchema,
  type SharedSearchHitWire,
  type SharedWithMeItemWire,
} from '@/lib/framework/resparkable/ui/payloads';

/** What each shareable type is called on screen. */
const TYPE_LABEL: Record<string, string> = {
  area: 'Life area',
  goal: 'Goal',
  project: 'Project',
  review: 'Review',
  board: 'Board',
  task: 'Task',
};

export function SharedWithMeView({ items }: { items: SharedWithMeItemWire[] }): React.ReactElement {
  const [query, setQuery] = React.useState('');
  const [hits, setHits] = React.useState<SharedSearchHitWire[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Which list this is. A group's shares and the person's never mix (phase 49).
  const inGroup = useActiveSpaceId() !== null;

  const runSearch = React.useCallback(async (term: string) => {
    const trimmed = term.trim();
    // An empty box is not an empty result — it is no search at all, and the
    // full list is the honest thing to show.
    if (trimmed.length === 0) {
      setHits(null);
      setError(null);
      return;
    }

    setSearching(true);
    setError(null);
    try {
      // With the active workspace, like every other read: inside a group this
      // searches what was shared with the group, and nothing of the person's.
      const response = await fetch(
        withActiveSpace(`${RESPARKABLE_API.SHARED_SEARCH}?q=${encodeURIComponent(trimmed)}`)
      );
      const payload: unknown = await response.json();
      if (!response.ok || !isSuccess(payload)) {
        setError('Could not search what has been shared with you.');
        return;
      }
      // Parsed, never cast. This is a network response, and the one rule
      // CLAUDE.md states about external data is that `as` is not how you
      // narrow it — a shape change upstream would otherwise surface as an
      // undefined field deep inside a render.
      const parsed = sharedSearchHitsSchema.safeParse(payload.data);
      if (!parsed.success) {
        setError('Could not read the search results.');
        return;
      }
      setHits(parsed.data);
    } catch {
      setError('Could not search what has been shared with you.');
    } finally {
      setSearching(false);
    }
  }, []);

  return (
    <div className="space-y-4">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(query);
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          // Not "Search". This matches words; saying otherwise sets an
          // expectation the mechanism cannot meet.
          placeholder="Match words in what has been shared with you"
          aria-label="Match words in what has been shared with you"
        />
        <Button type="submit" variant="secondary" disabled={searching}>
          <Search className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">Match words</span>
        </Button>
        {hits !== null && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setQuery('');
              setHits(null);
            }}
          >
            Clear
          </Button>
        )}
      </form>

      {error !== null && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {hits !== null ? (
        <SearchResults hits={hits} />
      ) : items.length === 0 ? (
        inGroup ? (
          <EmptyState
            icon={Handshake}
            title="Nothing has been shared with this group"
            description="When someone shares a project, a board or a goal with this group, everyone in it sees it here. Things shared with you personally are in your own workspace, not this one."
          />
        ) : (
          <EmptyState
            icon={Handshake}
            title="Nothing has been shared with you"
            description="When someone shares a project, a board or a goal with you, it appears here. Shared items stay in this section and never mix with your own, so your lists keep showing only what you have taken on."
          />
        )
      ) : (
        <ul className="space-y-2">
          {items.map((entry) => (
            <li key={`${entry.owner.id}:${entry.item.entityType}:${entry.item.id}`}>
              <SharedRow entry={entry} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SharedRow({ entry }: { entry: SharedWithMeItemWire }): React.ReactElement {
  const { item, owner } = entry;

  return (
    <WorkspaceLink
      href={RESPARKABLE_ROUTES.sharedItem(item.entityType, item.id)}
      className="bg-card hover:bg-accent/40 block space-y-2 rounded-md border p-3 transition-colors"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{item.title}</span>

        <Badge variant="outline" className="text-[11px]">
          {TYPE_LABEL[item.entityType] ?? item.entityType}
        </Badge>

        {/* canComment, not the grant's role: a group viewer holds a commenter grant
            through the group and still cannot comment (phase 49). */}
        {entry.canComment && (
          <Badge variant="secondary" className="text-[11px]">
            you can comment
          </Badge>
        )}

        {item.archived && (
          <Badge variant="outline" className="text-[11px]">
            archived by its owner
          </Badge>
        )}

        <span className="text-muted-foreground ml-auto text-xs">
          <ClientDate date={entry.sharedAt} />
        </span>
      </div>

      <p className="text-muted-foreground text-xs">
        Shared by {sharedOwnerLabel(owner)}
        {entry.expiresAt !== null && (
          <>
            {' · access ends '}
            <ClientDate date={entry.expiresAt} />
          </>
        )}
      </p>

      {item.body !== null && item.body.length > 0 && (
        <p className="text-muted-foreground line-clamp-2 text-sm">{item.body}</p>
      )}
    </WorkspaceLink>
  );
}

function SearchResults({ hits }: { hits: SharedSearchHitWire[] }): React.ReactElement {
  if (hits.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing shared with you contains those words. This matches words as they are written, so a
        different wording of the same idea will not be found.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {hits.map((hit) => (
        <li
          key={`${hit.owner.id}:${hit.item.entityType}:${hit.item.id}`}
          className="bg-card space-y-1 rounded-md border p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <WorkspaceLink
              href={RESPARKABLE_ROUTES.sharedItem(hit.item.entityType, hit.item.id)}
              className="font-medium hover:underline"
            >
              {hit.item.title}
            </WorkspaceLink>
            <Badge variant="outline" className="text-[11px]">
              {TYPE_LABEL[hit.item.entityType] ?? hit.item.entityType}
            </Badge>
          </div>
          <p className="text-muted-foreground text-xs">
            Shared by {sharedOwnerLabel(hit.owner)}
            {/* Names the granted parent, so a task found inside a shared
                project does not read as something handed over on its own. */}
            {hit.via !== null && ' · part of something shared with you'}
          </p>
        </li>
      ))}
    </ul>
  );
}

function isSuccess(payload: unknown): payload is { success: true; data: unknown } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'success' in payload &&
    payload.success === true &&
    'data' in payload
  );
}
