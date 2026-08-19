'use client';

/**
 * Launcher — what an empty pane shows: every section, grouped exactly like
 * the old nav rail (Daily / Organise / Knowledge / Manage), each tile
 * carrying the same one-line blurb `SectionHeader` shows on the equivalent
 * page today. A freshly split pane always opens here (`splitLeaf` seeds the
 * new leaf with `tabs: []`), and the tab strip's "+" reaches it from a pane
 * that already has tabs open, via `showLauncher`.
 *
 * "Ask Sparkey" is deliberately absent from `RESPARKABLE_NAV_GROUPS` here,
 * not just filtered by accident: `tab-registry.ts` has no `chat` kind
 * because Sparkey's own pane absorbs chat (§9) — `/resparkable/chat` is a
 * redirect from Phase 8 on, never a tab. Any nav item that doesn't resolve
 * to a real tab kind is skipped the same way, so the launcher can never
 * offer a tile that does nothing when clicked.
 */

import * as React from 'react';

import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import {
  RESPARKABLE_NAV_GROUPS,
  type NavGroup,
  type NavItem,
} from '@/lib/framework/resparkable/ui/nav-groups';
import { findSectionHelp } from '@/lib/framework/resparkable/ui/section-help';
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
  blurb: string | null;
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
      return [
        {
          item,
          blurb: findSectionHelp(item.href)?.blurb ?? null,
          kind: resolved.kind,
          params: resolved.params,
        },
      ];
    }),
  })).filter((group) => group.tiles.length > 0);
}

export function Launcher({ leafId }: LauncherProps): React.ReactElement {
  const workspace = useWorkspace();

  return (
    <div className="lattice-field-hex flex h-full flex-col gap-6 overflow-y-auto p-6">
      {launcherGroups().map((group) => (
        <div key={group.label}>
          <div className="term-label text-muted-foreground mb-2 px-1">{group.label}</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {group.tiles.map(({ item, blurb, kind, params }) => {
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
                  className="bg-card border-border hover:border-primary/50 hover:bg-accent/40 flex items-start gap-2.5 rounded-md border p-3 text-left transition-colors"
                >
                  <Icon
                    className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{item.label}</span>
                    {blurb && (
                      <span className="text-muted-foreground mt-0.5 block text-xs">{blurb}</span>
                    )}
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
