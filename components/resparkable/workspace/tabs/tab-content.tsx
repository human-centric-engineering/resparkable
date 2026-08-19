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
import { TodayTab } from '@/components/resparkable/workspace/tabs/today-tab';
import { VaultTab } from '@/components/resparkable/workspace/tabs/vault-tab';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import type { TabState } from '@/lib/framework/resparkable/ui/workspace/tab-registry';

export interface TabContentProps {
  tab: TabState;
}

export function TabContent({ tab }: TabContentProps): React.ReactElement {
  switch (tab.kind) {
    case 'today':
      return <TodayTab />;
    case 'inbox':
      return <InboxTab />;
    case 'plan':
      return <PlanTab />;
    case 'projects':
      return <ProjectsTab />;
    case 'project':
      return <ProjectTab id={tab.params.id!} />;
    case 'goals':
      return <GoalsTab />;
    case 'areas':
      return <AreasTab />;
    case 'boards':
      return <BoardsTab />;
    case 'board':
      return <BoardTab slug={tab.params.slug!} />;
    case 'documents':
      return <DocumentsTab />;
    case 'entities':
      return <EntitiesTab />;
    case 'entity':
      return <EntityTab id={tab.params.id!} />;
    case 'connections':
      return <ConnectionsTab />;
    case 'graph':
      return <GraphTab focusType={tab.params.focusType} focus={tab.params.focus} />;
    case 'vault':
      return <VaultTab />;
    case 'settings':
      return <SettingsTab />;
    case 'archive':
      return <ArchiveTab />;
    case 'search':
      return <SearchTab query={tab.params.query} />;
    case 'note':
      return <NoteTab id={tab.params.id!} />;
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
