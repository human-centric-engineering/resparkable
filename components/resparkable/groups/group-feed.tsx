'use client';

/**
 * The group activity feed (§23.10, phase 59): what has happened in the group
 * workspace, now, without waiting for the weekly digest.
 *
 * Polled while the page is visible (`useVisibilityPoll`), with `If-None-Match`
 * so an unchanged feed is a 304 and nothing re-renders. Refetched at once when
 * this tab's own boundary moves (something changed here).
 *
 * **Not a monitor.** Each line leads with the item and gives the person as
 * attribution (`feedLine`). There is no count anywhere on this surface: not of
 * lines, not of new lines, not per member. "Filter to one person" returns
 * their lines and says nothing about how many.
 */

import * as React from 'react';

import {
  memberName,
  useActiveGroupMembers,
} from '@/components/resparkable/groups/use-active-group-members';
import { useVisibilityPoll } from '@/components/resparkable/workspace/use-visibility-poll';
import { useTabRefreshGeneration } from '@/components/resparkable/workspace/tabs/tab-refresh-context';
import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { withActiveSpace } from '@/lib/framework/resparkable/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { feedLine, isNew } from '@/lib/framework/resparkable/ui/feed-lines';
import {
  feedPageSchema,
  type FeedItemWire,
  type FeedPageWire,
} from '@/lib/framework/resparkable/ui/payloads';
import { cn } from '@/lib/utils';

/** Half a minute: a study group does not need sub-second news (§23.14 q7). */
const POLL_INTERVAL_MS = 30_000;
const EVERYONE = '__everyone__';

type FetchResult = { status: 'changed'; page: FeedPageWire } | { status: 'unchanged' } | null;

async function fetchFeed(
  url: string,
  etag: string | null
): Promise<{ result: FetchResult; etag: string | null }> {
  try {
    const response = await fetch(withActiveSpace(url), {
      headers: etag ? { 'If-None-Match': etag } : {},
    });
    if (response.status === 304) return { result: { status: 'unchanged' }, etag };
    if (!response.ok) return { result: null, etag };
    const payload: unknown = await response.json();
    const data =
      typeof payload === 'object' && payload !== null && 'data' in payload ? payload.data : null;
    const parsed = feedPageSchema.safeParse(data);
    return {
      result: parsed.success ? { status: 'changed', page: parsed.data } : null,
      etag: response.headers.get('ETag'),
    };
  } catch {
    return { result: null, etag };
  }
}

/**
 * The first page and the older pages as one list: newest first, each line
 * once. A poll can return lines an older page already holds once enough new
 * ones push them down, so lines are merged by id rather than concatenated.
 */
function mergeLines(first: FeedItemWire[], older: FeedItemWire[]): FeedItemWire[] {
  const byId = new Map<string, FeedItemWire>();
  for (const item of [...first, ...older]) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) =>
    a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)
  );
}

export function GroupFeed(): React.ReactElement {
  const generation = useTabRefreshGeneration();
  const members = useActiveGroupMembers();
  const [member, setMember] = React.useState<string>(EVERYONE);
  const [items, setItems] = React.useState<FeedItemWire[] | null>(null);
  const [older, setOlder] = React.useState<FeedItemWire[]>([]);
  // Whether anything lies beyond the oldest line on screen. Paging always goes
  // from the oldest line actually shown, never from a cursor saved at first
  // load: polling replaces the first page, and a saved cursor would leave a
  // gap between it and whatever slid off the end.
  const [hasOlder, setHasOlder] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  // What counts as new is fixed when the tab opens: marking the feed read on
  // open must not un-highlight the lines the reader has not looked at yet.
  const [seenAt, setSeenAt] = React.useState<string | null | undefined>(undefined);
  const etag = React.useRef<string | null>(null);
  const markedSeen = React.useRef(false);
  const olderLoaded = React.useRef(false);

  const url =
    member === EVERYONE
      ? RESPARKABLE_API.FEED
      : `${RESPARKABLE_API.FEED}?member=${encodeURIComponent(member)}`;

  const load = React.useCallback(async () => {
    const { result, etag: next } = await fetchFeed(url, etag.current);
    etag.current = next;
    if (result === null) {
      setFailed(true);
      return;
    }
    setFailed(false);
    if (result.status === 'unchanged') return;
    setItems(result.page.items);
    // Before anything older has been loaded, the first page decides it; after,
    // the older pages do, and a poll of the first page says nothing about them.
    if (!olderLoaded.current) setHasOlder(result.page.nextCursor !== null);
    setSeenAt((current) => (current === undefined ? result.page.seenAt : current));
    if (!markedSeen.current) {
      markedSeen.current = true;
      void fetch(withActiveSpace(RESPARKABLE_API.FEED_SEEN), { method: 'POST' }).catch(
        () => undefined
      );
    }
  }, [url]);

  // A new filter is a new list: start it from the top.
  React.useEffect(() => {
    etag.current = null;
    olderLoaded.current = false;
    setItems(null);
    setOlder([]);
    setHasOlder(false);
  }, [url]);

  React.useEffect(() => {
    void load();
  }, [load, generation]);

  // Polled only for everyone's lines. Filtered to one member it is a search,
  // asked once: the member filter reads an unindexed column (§23.10), and
  // repeating that walk every half-minute on every open laptop is the cost
  // polling was chosen to avoid.
  useVisibilityPoll(() => {
    if (member === EVERYONE) void load();
  }, POLL_INTERVAL_MS);

  const all = mergeLines(items ?? [], older);

  async function showOlder(): Promise<void> {
    const oldest = all[all.length - 1];
    if (!oldest) return;
    const cursor = `${oldest.createdAt}|${oldest.id}`;
    const separator = url.includes('?') ? '&' : '?';
    const { result } = await fetchFeed(
      `${url}${separator}before=${encodeURIComponent(cursor)}`,
      null
    );
    if (result?.status !== 'changed') return;
    olderLoaded.current = true;
    setOlder((current) => [...current, ...result.page.items]);
    setHasOlder(result.page.nextCursor !== null);
  }
  const lines = all
    .map((item) => ({ item, line: feedLine(item) }))
    .filter(
      (row): row is { item: FeedItemWire; line: NonNullable<ReturnType<typeof feedLine>> } =>
        row.line !== null
    );

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-base font-semibold">What&apos;s new</h2>
          <p className="text-muted-foreground text-sm">
            Everything that has happened in this group, newest first.
          </p>
        </div>
        {members !== null && members.length > 1 && (
          <Select value={member} onValueChange={setMember}>
            <SelectTrigger className="h-8 w-48 text-sm" aria-label="Show what one person did">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EVERYONE}>Everyone</SelectItem>
              {members.map((row) => (
                <SelectItem key={row.userId} value={row.userId}>
                  {memberName(row)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </header>

      {failed && items === null ? (
        <p className="text-muted-foreground text-sm">The feed could not be loaded.</p>
      ) : items === null ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : lines.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing has happened here yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {lines.map(({ item, line }) => {
            const fresh = isNew(item, seenAt ?? null);
            return (
              <li
                key={item.id}
                className={cn(
                  'flex flex-wrap items-baseline justify-between gap-2 rounded-md border px-3 py-2 text-sm',
                  fresh ? 'border-primary/40 bg-primary/5' : 'border-border/60'
                )}
              >
                <span className="min-w-0">
                  <span className="font-medium">{line.subject}</span>{' '}
                  <span className="text-muted-foreground">{line.predicate}</span>
                  {fresh && <span className="sr-only"> (new since you last looked)</span>}
                </span>
                <ClientDate
                  date={item.createdAt}
                  showTime
                  className="text-muted-foreground text-[11px]"
                />
              </li>
            );
          })}
        </ul>
      )}

      {hasOlder && items !== null && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => void showOlder()}>
            Show older
          </Button>
        </div>
      )}
    </div>
  );
}
