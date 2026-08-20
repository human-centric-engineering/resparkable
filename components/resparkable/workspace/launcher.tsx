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
 * "Ask Sparkey" is deliberately absent from `RESPARKABLE_NAV_GROUPS` here,
 * not just filtered by accident: `tab-registry.ts` has no `chat` kind
 * because Sparkey's own pane absorbs chat (§9) — `/resparkable/chat` is a
 * redirect from Phase 8 on, never a tab. Any nav item that doesn't resolve
 * to a real tab kind is skipped the same way, so the launcher can never
 * offer a tile that does nothing when clicked.
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

import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import {
  RESPARKABLE_NAV_GROUPS,
  type NavGroup,
  type NavItem,
} from '@/lib/framework/resparkable/ui/nav-groups';
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
function launcherGroups(): Array<{ label: NavGroup['label']; tiles: LauncherTile[] }> {
  return RESPARKABLE_NAV_GROUPS.map((group) => ({
    label: group.label,
    tiles: group.items.flatMap((item): LauncherTile[] => {
      const resolved = resolveTabForPathname(item.href);
      if (!resolved) return [];
      return [{ item, kind: resolved.kind, params: resolved.params }];
    }),
  })).filter((group) => group.tiles.length > 0);
}

export function Launcher({ leafId }: LauncherProps): React.ReactElement {
  const workspace = useWorkspace();

  return (
    <div className="lattice-field-hex @container flex h-full flex-col gap-6 overflow-y-auto p-6 [contain:paint]">
      <div className="text-center">
        <h2 className="font-display text-lg font-semibold">Open a tab</h2>
        <p className="text-muted-foreground mt-1 text-sm">Ask Sparkey, or pick a view</p>
      </div>
      {launcherGroups().map((group) => (
        <div key={group.label}>
          <div className="term-label text-muted-foreground mb-2 px-1">{group.label}</div>
          <div className="grid grid-cols-1 gap-2 @sm:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4">
            {group.tiles.map(({ item, kind, params }) => {
              const Icon = item.icon;
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
                  <Icon className="text-primary h-5 w-5 shrink-0" aria-hidden="true" />
                  <span className="text-sm font-semibold">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
