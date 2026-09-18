'use client';

/**
 * TabContent — dispatches a tab's `kind` to its adapter.
 *
 * This is the piece Phase 2's `workspace-pane-tree.tsx` placeholder said
 * would arrive in Phase 3: `WorkspacePane` renders this instead of the
 * "content adapter arrives in Phase 3" message now that every adapter
 * exists.
 *
 * The four kinds with required params (`project`, `entity`, `board`,
 * `note`) assert them non-null rather than defending against their
 * absence: `tab.params` is internal state, always built by
 * `tab-registry.ts`'s `resolveTabForPathname`/`buildRouteForTab` or by a
 * caller of `openTab()` who supplied the matching params for that kind —
 * not external input this file has any reason to distrust.
 *
 * `capture` has no case with real content: nothing ever opens it as a
 * launcher tab (it isn't in `RESPARKABLE_NAV_GROUPS` — see `launcher.tsx`),
 * and a route-backed open renders the real page via `route-tab-bridge.tsx`
 * (Phase 8), never this dispatcher. The fallback below is a safety net for
 * that invariant, not an expected path.
 *
 * ## Why `tabId` is threaded into so many adapters
 *
 * Two things a tab can only do if it knows its own id: **name itself** from
 * its loaded content (`setTabTitle`, the four detail kinds), and **hold its
 * own filter** rather than the browser's (`setTabParams` — Plan's day,
 * Projects' status, Search's include-archived). Both context actions key on
 * the tab id alone, deliberately, so no adapter has to be told which pane is
 * rendering it or whether it is floating in a window instead. That is why
 * `tabId` arrives as a plain prop here rather than through a context: it
 * makes each adapter independently testable with a stub, which is exactly
 * what its own test file does.
 */

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';

import { AreasTab } from '@/components/resparkable/workspace/tabs/areas-tab';
import { ArchiveTab } from '@/components/resparkable/workspace/tabs/archive-tab';
import { BoardTab } from '@/components/resparkable/workspace/tabs/board-tab';
import { BoardsTab } from '@/components/resparkable/workspace/tabs/boards-tab';
import { ConnectionsTab } from '@/components/resparkable/workspace/tabs/connections-tab';
import { DocumentsTab } from '@/components/resparkable/workspace/tabs/documents-tab';
import { EntitiesTab } from '@/components/resparkable/workspace/tabs/entities-tab';
import { EntityTab } from '@/components/resparkable/workspace/tabs/entity-tab';
import { GoalsTab } from '@/components/resparkable/workspace/tabs/goals-tab';
import { GraphTab } from '@/components/resparkable/workspace/tabs/graph-tab';
import { InboxTab } from '@/components/resparkable/workspace/tabs/inbox-tab';
import { NoteTab } from '@/components/resparkable/workspace/tabs/note-tab';
import { PlanTab } from '@/components/resparkable/workspace/tabs/plan-tab';
import { ProjectTab } from '@/components/resparkable/workspace/tabs/project-tab';
import { ProjectsTab } from '@/components/resparkable/workspace/tabs/projects-tab';
import { SearchTab } from '@/components/resparkable/workspace/tabs/search-tab';
import { SettingsTab } from '@/components/resparkable/workspace/tabs/settings-tab';
import { TabRefreshBoundary } from '@/components/resparkable/workspace/tabs/tab-refresh-context';
import { TodayTab } from '@/components/resparkable/workspace/tabs/today-tab';
import { VaultTab } from '@/components/resparkable/workspace/tabs/vault-tab';
import { SharedItemTab } from '@/components/resparkable/workspace/tabs/shared-item-tab';
import { SharedTab } from '@/components/resparkable/workspace/tabs/shared-tab';
import { GroupTab } from '@/components/resparkable/workspace/tabs/group-tab';
import { GroupsTab } from '@/components/resparkable/workspace/tabs/groups-tab';
import { SharingTab } from '@/components/resparkable/workspace/tabs/sharing-tab';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import type { TabState } from '@/lib/framework/resparkable/ui/workspace/tab-registry';

export interface TabContentProps {
  tab: TabState;
}

/**
 * Wrapped in `TabRefreshBoundary` so that every mutating control inside this
 * tab — `ThoughtCard`'s triage buttons, a `CreateDialog` closing, a board
 * card drag — refreshes *this tab* rather than `router.refresh()`-ing the
 * whole route segment that every other pane also sits under. See
 * `tab-refresh-context.tsx` for why that was wrong in both directions at
 * once. Deliberately here rather than in `WorkspacePane`: the route-backed
 * tab renders the real server page instead of this dispatcher, and that one
 * tab genuinely does want `router.refresh()`.
 *
 * The boundary is handed the whole `tab`, not just its children, because it
 * also subscribes this tab to the shell-wide change broadcast on its
 * behalf — `change-scope.ts` maps `(kind, params)` to the changes that
 * matter to it. That is what lets a Sparkey capture reach an open Inbox tab
 * with no wiring in `InboxTab` itself. `renderTab(tab)` is called here rather
 * than inside the boundary so the child element's identity survives a
 * broadcast that this tab does not care about, and React skips the subtree.
 */
export function TabContent({ tab }: TabContentProps): React.ReactElement {
  return <TabRefreshBoundary tab={tab}>{renderTab(tab)}</TabRefreshBoundary>;
}

function renderTab(tab: TabState): React.ReactElement {
  switch (tab.kind) {
    case 'today':
      return <TodayTab />;
    case 'inbox':
      return <InboxTab />;
    case 'plan':
      return <PlanTab tabId={tab.id} day={tab.params.day} />;
    case 'projects':
      return <ProjectsTab tabId={tab.id} status={tab.params.status ?? null} />;
    case 'project':
      return <ProjectTab tabId={tab.id} id={tab.params.id!} />;
    case 'goals':
      return <GoalsTab />;
    case 'areas':
      return <AreasTab />;
    case 'boards':
      return <BoardsTab />;
    case 'board':
      return <BoardTab tabId={tab.id} slug={tab.params.slug!} />;
    case 'documents':
      return <DocumentsTab />;
    case 'entities':
      return <EntitiesTab />;
    case 'entity':
      return <EntityTab tabId={tab.id} id={tab.params.id!} />;
    case 'connections':
      return <ConnectionsTab />;
    case 'graph':
      return <GraphTab focusType={tab.params.focusType} focus={tab.params.focus} />;
    case 'shared':
      return <SharedTab />;
    case 'sharedItem':
      return (
        <SharedItemTab tabId={tab.id} entityType={tab.params.entityType!} id={tab.params.id!} />
      );
    case 'sharing':
      return <SharingTab />;
    case 'groups':
      return <GroupsTab />;
    case 'group':
      return <GroupTab id={tab.params.id!} />;
    case 'vault':
      return <VaultTab />;
    case 'settings':
      return <SettingsTab />;
    case 'archive':
      return <ArchiveTab />;
    case 'search':
      return (
        <SearchTab
          tabId={tab.id}
          query={tab.params.query}
          includeArchived={tab.params.includeArchived === true}
        />
      );
    case 'note':
      return <NoteTab tabId={tab.id} id={tab.params.id!} />;
    case 'capture':
      return (
        <EmptyState
          icon={AlertTriangle}
          title="Nothing to show here"
          description="Capture doesn't open as a tab — this shouldn't be reachable."
        />
      );
  }
}
