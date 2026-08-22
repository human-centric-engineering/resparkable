'use client';

/**
 * Launcher — what an empty pane shows: a page-level "Open a tab" title
 * and one-line blurb, then every section grouped exactly like the old nav
 * rail (Daily / Organise / Knowledge / Manage). A freshly split pane always
 * opens here (`splitLeaf` seeds the new leaf with `tabs: []`), and the tab
 * strip's "+" reaches it from a pane that already has tabs open, via
 * `showLauncher`.
 *
 * Tiles themselves are icon-over-label only — no per-tile blurb. A first
 * cut carried `SectionHeader`'s one-line blurb under each label
 * (`findSectionHelp`), but live review asked for the picker simplified down
 * to what the design reference shows: a big, coloured icon and a name,
 * nothing else per tile. The blurb itself isn't gone from the app —
 * `SectionHeader` still shows it on the page a tile opens — it just isn't
 * repeated on every tile here too. The *page-level* title/blurb above is a
 * separate thing (what this screen is, not what one tile does), and stays.
 *
 * "Ask Sparkey" is not a tile because it is not a destination: Sparkey's own
 * pane is always on screen, `tab-registry.ts` has no `chat` kind, and
 * `/resparkable/chat` is a redirect. It was skipped here for a while and has
 * since been removed from `RESPARKABLE_NAV_GROUPS` outright, so today nothing
 * in the nav registry fails to resolve. The `flatMap` below still drops a
 * non-resolving item rather than assuming that stays true: the invariant
 * worth keeping is that the launcher can never offer a tile that does
 * nothing when clicked.
 *
 * ## The one tile that carries a number
 *
 * The old nav rail carried "N waiting" badges on Inbox and Connections, fed by
 * `GET /resparkable/counts`. The rail went with the cutover and took both with
 * it. Connections needs no replacement — the Activity pane is a live, always-
 * on-screen feed of the very same pending suggestions, which is strictly more
 * than a count was. Inbox had nothing left, and un-triaged thoughts that are
 * invisible are un-triaged thoughts that stay that way, so the count comes
 * back here.
 *
 * Only Inbox. `openTasks` is deliberately not shown: it is a count of things
 * that are open rather than things waiting on a decision, and a badge that
 * never reaches zero is a badge people learn to stop seeing. That is the same
 * rule `services/counts.ts` states for why snoozed and deferred rows are
 * excluded from the numbers at all.
 *
 * Every pane showing its launcher fetches this independently. That is fine
 * rather than an oversight: the endpoint is three indexed counts and is
 * ETag'd, so the second and later panes cost a 304 and no payload.
 *
 * `[contain:paint]` on the root div, alongside `.lattice-field-hex`: that
 * class's own `::before` honeycomb switches to `position: fixed` under
 * `(hover: hover) and (pointer: fine)` (`brand-theme.css`) — a parallax
 * trick that's correct when `.lattice-field-hex` is the whole page
 * (`(protected)/layout.tsx`, `(public)/layout.tsx`), since `fixed` there is
 * the viewport anyway. Nested inside `WorkspaceShell`'s three-pane layout,
 * the same `position: fixed` positions against the real viewport too —
 * live review caught it bleeding the honeycomb across Sparkey and Activity,
 * not just this pane. `contain: paint` makes this div itself the containing
 * block for that fixed-position pseudo-element (and for the class's own
 * `background-attachment: fixed`), scoping both to the launcher pane
 * without touching the shared class or either full-page layout that relies
 * on the viewport-wide behavior.
 */

import * as React from 'react';

import { useDataRevision } from '@/components/resparkable/workspace/data-change-context';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import {
  RESPARKABLE_NAV_GROUPS,
  type NavGroup,
  type NavItem,
} from '@/lib/framework/resparkable/ui/nav-groups';
import { countsSchema } from '@/lib/framework/resparkable/ui/payloads';
import {
  resolveTabForPathname,
  type TabKind,
  type TabParams,
} from '@/lib/framework/resparkable/ui/workspace/tab-registry';

export interface LauncherProps {
  leafId: string;
}

interface LauncherTile {
  item: NavItem;
  kind: TabKind;
  params: TabParams;
}

/**
 * `RESPARKABLE_NAV_GROUPS`, narrowed to items that resolve to a real tab
 * kind. Built with `flatMap` rather than `map` + `filter` so a
 * non-resolvable item (only `chat`, today) never becomes a tile with a
 * nullable `kind` in the first place — nothing downstream has to re-check.
 */
function buildLauncherGroups(): Array<{ label: NavGroup['label']; tiles: LauncherTile[] }> {
  return RESPARKABLE_NAV_GROUPS.map((group) => ({
    label: group.label,
    tiles: group.items.flatMap((item): LauncherTile[] => {
      const resolved = resolveTabForPathname(item.href);
      if (!resolved) return [];
      return [{ item, kind: resolved.kind, params: resolved.params }];
    }),
  })).filter((group) => group.tiles.length > 0);
}

// `RESPARKABLE_NAV_GROUPS` is a static module-level constant, so this never
// changes across renders — computed once here rather than redone on every
// render of every empty pane (which re-renders on any `useWorkspace()` change).
const LAUNCHER_GROUPS = buildLauncherGroups();

export function Launcher({ leafId }: LauncherProps): React.ReactElement {
  const workspace = useWorkspace();
  // A failed or still-loading counts fetch shows no badge rather than no
  // launcher — the same call the old layout made, for the same reason it made
  // it: a badge is an affordance, and a picker that broke over a decoration
  // would take out the only way to open anything.
  // Subscribed to `thought` explicitly. This component renders in an *empty*
  // pane, so it sits outside every `TabRefreshBoundary` and would otherwise
  // hold its mount-time count forever — including through the exact flow the
  // badge exists for: capturing a thought in Sparkey while an empty pane shows
  // the launcher beside it.
  const inboxRevision = useDataRevision(['thought']);
  const [counts] = useTabFetch(RESPARKABLE_API.COUNTS, countsSchema, inboxRevision);
  const inboxCount = counts.status === 'ready' ? counts.data.inbox : 0;

  return (
    <div className="lattice-field-hex @container flex h-full flex-col gap-6 overflow-y-auto p-6 [contain:paint]">
      <div className="text-center">
        <h2 className="font-display text-lg font-semibold">Open a tab</h2>
        <p className="text-muted-foreground mt-1 text-sm">Ask Sparkey, or pick a view</p>
      </div>
      {LAUNCHER_GROUPS.map((group) => (
        <div key={group.label}>
          <div className="term-label text-muted-foreground mb-2 px-1">{group.label}</div>
          <div className="grid grid-cols-1 gap-2 @sm:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4">
            {group.tiles.map(({ item, kind, params }) => {
              const Icon = item.icon;
              const badge = kind === 'inbox' && inboxCount > 0 ? inboxCount : null;
              return (
                <button
                  key={item.href}
                  type="button"
                  onClick={() => {
                    // openTab() targets focusedLeafId, which is a different
                    // pane whenever this launcher is showing in one that
                    // isn't currently focused (e.g. via the tab strip's "+"
                    // in a pane you're not on) — focus this leaf first so
                    // the tab lands where the click actually happened.
                    workspace.focusLeaf(leafId);
                    workspace.openTab(kind, params);
                  }}
                  // `hover:bg-accent` is solid, not `/40`: this pane sits on
                  // `.lattice-field-hex`'s honeycomb, and a translucent hover
                  // tint let it bleed straight through the "highlighted"
                  // card — the one state that most needs to read as opaque.
                  className="bg-card border-border hover:border-primary/50 hover:bg-accent flex flex-col items-start gap-3 rounded-lg border p-4 text-left transition-colors"
                >
                  <div className="flex w-full items-start justify-between gap-2">
                    <Icon className="text-primary h-5 w-5 shrink-0" aria-hidden="true" />
                    {badge !== null && (
                      // The count is in the accessible name rather than beside
                      // it as decoration — a screen reader hears "Inbox, 7
                      // waiting" from the button itself, which is the whole
                      // point of the badge and is otherwise silent.
                      <span
                        className="bg-primary/10 text-primary rounded-full px-1.5 py-0.5 text-[11px] leading-none font-semibold tabular-nums"
                        aria-hidden="true"
                      >
                        {badge}
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-semibold">
                    {item.label}
                    {badge !== null && <span className="sr-only">, {badge} waiting</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
