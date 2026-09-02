// @vitest-environment happy-dom

/**
 * Unit Tests: TabContent.
 *
 * Every adapter is mocked to a marker that dumps its own props — this file
 * is only about the dispatch wiring (does `kind` reach the right component,
 * with the right params pulled off `tab.params`), not about any adapter's
 * own fetch/render behavior, which belongs to that adapter's own test (see
 * `use-tab-fetch.test.ts` for the shared piece they're all built on).
 *
 * @see components/resparkable/workspace/tabs/tab-content.tsx
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TabContent } from '@/components/resparkable/workspace/tabs/tab-content';
import type {
  TabKind,
  TabParams,
  TabState,
} from '@/lib/framework/resparkable/ui/workspace/tab-registry';

function marker(name: string) {
  return function Marker(props: Record<string, unknown>): React.ReactElement {
    return <div data-testid={name}>{JSON.stringify(props)}</div>;
  };
}

vi.mock('@/components/resparkable/workspace/tabs/today-tab', () => ({ TodayTab: marker('today') }));
vi.mock('@/components/resparkable/workspace/tabs/inbox-tab', () => ({ InboxTab: marker('inbox') }));
vi.mock('@/components/resparkable/workspace/tabs/plan-tab', () => ({ PlanTab: marker('plan') }));
vi.mock('@/components/resparkable/workspace/tabs/projects-tab', () => ({
  ProjectsTab: marker('projects'),
}));
vi.mock('@/components/resparkable/workspace/tabs/project-tab', () => ({
  ProjectTab: marker('project'),
}));
vi.mock('@/components/resparkable/workspace/tabs/goals-tab', () => ({ GoalsTab: marker('goals') }));
vi.mock('@/components/resparkable/workspace/tabs/areas-tab', () => ({ AreasTab: marker('areas') }));
vi.mock('@/components/resparkable/workspace/tabs/boards-tab', () => ({
  BoardsTab: marker('boards'),
}));
vi.mock('@/components/resparkable/workspace/tabs/board-tab', () => ({ BoardTab: marker('board') }));
vi.mock('@/components/resparkable/workspace/tabs/documents-tab', () => ({
  DocumentsTab: marker('documents'),
}));
vi.mock('@/components/resparkable/workspace/tabs/entities-tab', () => ({
  EntitiesTab: marker('entities'),
}));
vi.mock('@/components/resparkable/workspace/tabs/entity-tab', () => ({
  EntityTab: marker('entity'),
}));
vi.mock('@/components/resparkable/workspace/tabs/connections-tab', () => ({
  ConnectionsTab: marker('connections'),
}));
vi.mock('@/components/resparkable/workspace/tabs/graph-tab', () => ({ GraphTab: marker('graph') }));
vi.mock('@/components/resparkable/workspace/tabs/vault-tab', () => ({ VaultTab: marker('vault') }));
vi.mock('@/components/resparkable/workspace/tabs/settings-tab', () => ({
  SettingsTab: marker('settings'),
}));
vi.mock('@/components/resparkable/workspace/tabs/archive-tab', () => ({
  ArchiveTab: marker('archive'),
}));
vi.mock('@/components/resparkable/workspace/tabs/search-tab', () => ({
  SearchTab: marker('search'),
}));
vi.mock('@/components/resparkable/workspace/tabs/note-tab', () => ({ NoteTab: marker('note') }));

function tab(kind: TabKind, params: TabParams = {}): TabState {
  return { id: 't1', kind, params, source: 'launcher' };
}

describe('TabContent — dispatch', () => {
  it.each<[TabKind, TabParams]>([
    ['today', {}],
    ['inbox', {}],
    ['plan', {}],
    ['projects', {}],
    ['goals', {}],
    ['areas', {}],
    ['boards', {}],
    ['documents', {}],
    ['entities', {}],
    ['connections', {}],
    ['vault', {}],
    ['settings', {}],
    ['archive', {}],
  ])('renders the %s adapter with no params required', (kind) => {
    render(<TabContent tab={tab(kind)} />);
    expect(screen.getByTestId(kind)).toBeInTheDocument();
  });

  it('passes id through to ProjectTab', () => {
    render(<TabContent tab={tab('project', { id: 'proj_1' })} />);
    expect(screen.getByTestId('project')).toHaveTextContent('"id":"proj_1"');
  });

  it('passes id through to EntityTab', () => {
    render(<TabContent tab={tab('entity', { id: 'ent_1' })} />);
    expect(screen.getByTestId('entity')).toHaveTextContent('"id":"ent_1"');
  });

  it('passes slug through to BoardTab', () => {
    render(<TabContent tab={tab('board', { slug: 'roadmap' })} />);
    expect(screen.getByTestId('board')).toHaveTextContent('"slug":"roadmap"');
  });

  it('passes id through to NoteTab', () => {
    render(<TabContent tab={tab('note', { id: 'thought_1' })} />);
    expect(screen.getByTestId('note')).toHaveTextContent('"id":"thought_1"');
  });

  it('passes query through to SearchTab', () => {
    render(<TabContent tab={tab('search', { query: 'roadmap' })} />);
    expect(screen.getByTestId('search')).toHaveTextContent('"query":"roadmap"');
  });

  it('passes focusType and focus through to GraphTab', () => {
    render(<TabContent tab={tab('graph', { focusType: 'project', focus: 'proj_1' })} />);
    expect(screen.getByTestId('graph')).toHaveTextContent('"focusType":"project"');
    expect(screen.getByTestId('graph')).toHaveTextContent('"focus":"proj_1"');
  });

  it('renders a safety-net empty state for capture, which nothing should ever open as a tab', () => {
    render(<TabContent tab={tab('capture', {})} />);
    expect(screen.getByText('Nothing to show here')).toBeInTheDocument();
  });
});
