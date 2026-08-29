/**
 * Unit Tests: Resparkable collection-page server components
 *
 * Covers the "list" pages under app/(resparkable)/resparkable/: inbox, projects,
 * goals, areas, entities, documents, boards. Each is an async Server
 * Component whose only real logic is (a) which endpoint(s)/query strings it
 * asks `readResparkable()` for, (b) which failure renders `<LoadError>`, and
 * (c) which secondary-read failures degrade gracefully (empty array) rather
 * than failing the whole page.
 *
 * `readResparkable` is the one seam every page reads through — mocked here so
 * these tests exercise the page's own branching, not the fetch/schema
 * plumbing (already covered by tests/unit/lib/framework/resparkable/ui/server-read.test.ts).
 * Child view components are stubbed to prop-capturing divs so assertions
 * check what the page *handed down*, not how the view renders it.
 *
 * @see app/(resparkable)/resparkable/inbox/page.tsx
 * @see app/(resparkable)/resparkable/projects/page.tsx
 * @see app/(resparkable)/resparkable/goals/page.tsx
 * @see app/(resparkable)/resparkable/areas/page.tsx
 * @see app/(resparkable)/resparkable/entities/page.tsx
 * @see app/(resparkable)/resparkable/documents/page.tsx
 * @see app/(resparkable)/resparkable/boards/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/framework/resparkable/ui/server-read', () => ({
  readResparkable: vi.fn(),
}));

vi.mock('@/lib/resparkable/get-sparkey-pronoun', () => ({
  getSparkeyPronoun: vi.fn(),
}));

vi.mock('@/components/resparkable/inbox/inbox-view', () => ({
  InboxView: (props: { payload: unknown; projects: unknown[] }) => (
    <div data-testid="inbox-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/resparkable/projects/projects-view', () => ({
  ProjectsView: (props: { projects: unknown[]; areas: unknown[]; status: string | null }) => (
    <div data-testid="projects-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/resparkable/goals/goals-view', () => ({
  GoalsView: (props: { goals: unknown[]; areas: unknown[]; pronoun?: string }) => (
    <div data-testid="goals-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/resparkable/areas/areas-view', () => ({
  AreasView: (props: { areas: unknown[]; pronoun?: string }) => (
    <div data-testid="areas-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/resparkable/entities/entities-view', () => ({
  EntitiesView: (props: { entities: unknown[] }) => (
    <div data-testid="entities-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/resparkable/documents/documents-view', () => ({
  DocumentsView: (props: { documents: unknown[] }) => (
    <div data-testid="documents-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/resparkable/board/boards-list', () => ({
  BoardsList: (props: { boards: unknown[]; projects: unknown[]; tags: unknown[] }) => (
    <div data-testid="boards-list" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/resparkable/share/shared-with-me-view', () => ({
  SharedWithMeView: (props: { items: unknown[] }) => (
    <div data-testid="shared-with-me-view" data-props={JSON.stringify(props)} />
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';
import { getSparkeyPronoun } from '@/lib/resparkable/get-sparkey-pronoun';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ok<T>(
  data: T,
  meta?: { total?: number; count?: number }
): {
  ok: true;
  data: T;
  meta?: { total?: number; count?: number };
} {
  return meta ? { ok: true, data, meta } : { ok: true, data };
}

function fail(
  status: number | null,
  message = 'boom'
): { ok: false; status: number | null; message: string } {
  return { ok: false, status, message };
}

function callPaths(): string[] {
  return vi.mocked(readResparkable).mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Only Goals and Areas consume this; default it everywhere so pages that
  // don't care about the pronoun don't need to know it exists.
  vi.mocked(getSparkeyPronoun).mockResolvedValue('it');
});

// ─── Inbox ────────────────────────────────────────────────────────────────────

describe('ResparkableInboxPage', () => {
  it('reads the inbox and active-projects endpoints concurrently', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableInboxPage } =
      await import('@/app/(resparkable)/resparkable/inbox/page');

    await ResparkableInboxPage();

    expect(callPaths()).toEqual([
      RESPARKABLE_API.INBOX,
      `${RESPARKABLE_API.PROJECTS}?status=active&limit=200`,
    ]);
  });

  it('renders LoadError when the inbox read fails', async () => {
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path === RESPARKABLE_API.INBOX ? fail(500, 'inbox down') : ok([])
    );
    const { default: ResparkableInboxPage } =
      await import('@/app/(resparkable)/resparkable/inbox/page');

    render(await ResparkableInboxPage());

    expect(screen.getByRole('alert')).toHaveTextContent('inbox down');
    expect(screen.queryByTestId('inbox-view')).not.toBeInTheDocument();
  });

  it('degrades to an empty projects list when the secondary read fails, but still renders the inbox', async () => {
    const inboxPayload = { generatedAt: 'now', total: 0, items: [] };
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path === RESPARKABLE_API.INBOX ? ok(inboxPayload) : fail(500, 'projects down')
    );
    const { default: ResparkableInboxPage } =
      await import('@/app/(resparkable)/resparkable/inbox/page');

    render(await ResparkableInboxPage());

    const view = screen.getByTestId('inbox-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      payload: unknown;
      projects: unknown[];
    };
    expect(props.payload).toEqual(inboxPayload);
    expect(props.projects).toEqual([]);
  });

  it('forwards both payloads to InboxView when both reads succeed', async () => {
    const inboxPayload = { generatedAt: 'now', total: 1, items: [] };
    const projects = [{ id: 'p1', name: 'Project One' }];
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path === RESPARKABLE_API.INBOX ? ok(inboxPayload) : ok(projects)
    );
    const { default: ResparkableInboxPage } =
      await import('@/app/(resparkable)/resparkable/inbox/page');

    render(await ResparkableInboxPage());

    const view = screen.getByTestId('inbox-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      payload: unknown;
      projects: unknown[];
    };
    expect(props.payload).toEqual(inboxPayload);
    expect(props.projects).toEqual(projects);
  });
});

// ─── Projects ─────────────────────────────────────────────────────────────────

describe('ResparkableProjectsPage', () => {
  it('reads projects with limit=200 (no status) and areas concurrently when no status is given', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableProjectsPage } =
      await import('@/app/(resparkable)/resparkable/projects/page');

    await ResparkableProjectsPage({ searchParams: Promise.resolve({}) });

    expect(callPaths()).toEqual([
      `${RESPARKABLE_API.PROJECTS}?limit=200`,
      `${RESPARKABLE_API.AREAS}?limit=200`,
    ]);
  });

  it('includes a recognised status in the projects query', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableProjectsPage } =
      await import('@/app/(resparkable)/resparkable/projects/page');

    await ResparkableProjectsPage({ searchParams: Promise.resolve({ status: 'active' }) });

    expect(callPaths()[0]).toBe(`${RESPARKABLE_API.PROJECTS}?limit=200&status=active`);
  });

  it('drops an unrecognised status rather than passing it through', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableProjectsPage } =
      await import('@/app/(resparkable)/resparkable/projects/page');

    await ResparkableProjectsPage({
      searchParams: Promise.resolve({ status: 'not-a-real-status' }),
    });

    expect(callPaths()[0]).toBe(`${RESPARKABLE_API.PROJECTS}?limit=200`);
  });

  it('renders LoadError when the projects read fails', async () => {
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.PROJECTS) ? fail(500, 'projects down') : ok([])
    );
    const { default: ResparkableProjectsPage } =
      await import('@/app/(resparkable)/resparkable/projects/page');

    render(await ResparkableProjectsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('alert')).toHaveTextContent('projects down');
    expect(screen.queryByTestId('projects-view')).not.toBeInTheDocument();
  });

  it('degrades to an empty areas list when the secondary read fails', async () => {
    const projects = [{ id: 'p1' }];
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.PROJECTS) ? ok(projects) : fail(500, 'areas down')
    );
    const { default: ResparkableProjectsPage } =
      await import('@/app/(resparkable)/resparkable/projects/page');

    render(await ResparkableProjectsPage({ searchParams: Promise.resolve({}) }));

    const view = screen.getByTestId('projects-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      projects: unknown[];
      areas: unknown[];
      status: string | null;
    };
    expect(props.projects).toEqual(projects);
    expect(props.areas).toEqual([]);
    expect(props.status).toBeNull();
  });
});

// ─── Goals ────────────────────────────────────────────────────────────────────

describe('ResparkableGoalsPage', () => {
  it('reads goals and areas concurrently, both with limit=200', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableGoalsPage } =
      await import('@/app/(resparkable)/resparkable/goals/page');

    await ResparkableGoalsPage();

    expect(callPaths()).toEqual([
      `${RESPARKABLE_API.GOALS}?limit=200`,
      `${RESPARKABLE_API.AREAS}?limit=200`,
    ]);
  });

  it('renders LoadError when the goals read fails', async () => {
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.GOALS) ? fail(503, 'goals down') : ok([])
    );
    const { default: ResparkableGoalsPage } =
      await import('@/app/(resparkable)/resparkable/goals/page');

    render(await ResparkableGoalsPage());

    expect(screen.getByRole('alert')).toHaveTextContent('goals down');
  });

  it('degrades to an empty areas list when the secondary read fails', async () => {
    const goals = [{ id: 'g1' }];
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.GOALS) ? ok(goals) : fail(500, 'areas down')
    );
    const { default: ResparkableGoalsPage } =
      await import('@/app/(resparkable)/resparkable/goals/page');

    render(await ResparkableGoalsPage());

    const view = screen.getByTestId('goals-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      goals: unknown[];
      areas: unknown[];
    };
    expect(props.goals).toEqual(goals);
    expect(props.areas).toEqual([]);
  });

  it('forwards the areas data when the secondary read succeeds too', async () => {
    const goals = [{ id: 'g1' }];
    const areas = [{ id: 'a1', name: 'Career' }];
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.GOALS) ? ok(goals) : ok(areas)
    );
    const { default: ResparkableGoalsPage } =
      await import('@/app/(resparkable)/resparkable/goals/page');

    render(await ResparkableGoalsPage());

    const view = screen.getByTestId('goals-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      goals: unknown[];
      areas: unknown[];
    };
    expect(props.goals).toEqual(goals);
    expect(props.areas).toEqual(areas);
  });

  it('forwards the resolved Sparkey pronoun to GoalsView', async () => {
    vi.mocked(readResparkable).mockResolvedValue(ok([]));
    vi.mocked(getSparkeyPronoun).mockResolvedValue('he');
    const { default: ResparkableGoalsPage } =
      await import('@/app/(resparkable)/resparkable/goals/page');

    render(await ResparkableGoalsPage());

    const view = screen.getByTestId('goals-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as { pronoun: string };
    expect(props.pronoun).toBe('he');
  });
});

// ─── Areas ────────────────────────────────────────────────────────────────────

describe('ResparkableAreasPage', () => {
  it('reads only the areas endpoint', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableAreasPage } =
      await import('@/app/(resparkable)/resparkable/areas/page');

    await ResparkableAreasPage();

    expect(callPaths()).toEqual([`${RESPARKABLE_API.AREAS}?limit=200`]);
  });

  it('renders LoadError when the areas read fails', async () => {
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.AREAS) ? fail(500, 'areas down') : ok({})
    );
    const { default: ResparkableAreasPage } =
      await import('@/app/(resparkable)/resparkable/areas/page');

    render(await ResparkableAreasPage());

    expect(screen.getByRole('alert')).toHaveTextContent('areas down');
  });

  it('forwards the areas data when the read succeeds', async () => {
    const areas = [{ id: 'a1' }];
    vi.mocked(readResparkable).mockResolvedValue(ok(areas));
    const { default: ResparkableAreasPage } =
      await import('@/app/(resparkable)/resparkable/areas/page');

    render(await ResparkableAreasPage());

    const view = screen.getByTestId('areas-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as { areas: unknown[] };
    expect(props.areas).toEqual(areas);
  });

  it('forwards the resolved Sparkey pronoun to AreasView', async () => {
    vi.mocked(readResparkable).mockResolvedValue(ok([]));
    vi.mocked(getSparkeyPronoun).mockResolvedValue('she');
    const { default: ResparkableAreasPage } =
      await import('@/app/(resparkable)/resparkable/areas/page');

    render(await ResparkableAreasPage());

    const view = screen.getByTestId('areas-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as { pronoun: string };
    expect(props.pronoun).toBe('she');
  });
});

// ─── Entities ─────────────────────────────────────────────────────────────────

describe('ResparkableEntitiesPage', () => {
  it('reads the entities endpoint with limit=200', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableEntitiesPage } =
      await import('@/app/(resparkable)/resparkable/entities/page');

    await ResparkableEntitiesPage();

    expect(callPaths()).toEqual([`${RESPARKABLE_API.ENTITIES}?limit=200`]);
  });

  it('renders LoadError when the read fails', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500, 'entities down'));
    const { default: ResparkableEntitiesPage } =
      await import('@/app/(resparkable)/resparkable/entities/page');

    render(await ResparkableEntitiesPage());

    expect(screen.getByRole('alert')).toHaveTextContent('entities down');
  });

  it('forwards entities to EntitiesView on success', async () => {
    const entities = [{ id: 'e1', name: 'Acme' }];
    vi.mocked(readResparkable).mockResolvedValue(ok(entities));
    const { default: ResparkableEntitiesPage } =
      await import('@/app/(resparkable)/resparkable/entities/page');

    render(await ResparkableEntitiesPage());

    const view = screen.getByTestId('entities-view');
    expect(view.getAttribute('data-props')).toBe(JSON.stringify({ entities }));
  });
});

// ─── Documents ────────────────────────────────────────────────────────────────

describe('ResparkableDocumentsPage', () => {
  it('reads the documents endpoint with limit=100', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableDocumentsPage } =
      await import('@/app/(resparkable)/resparkable/documents/page');

    await ResparkableDocumentsPage();

    expect(callPaths()).toEqual([`${RESPARKABLE_API.DOCUMENTS}?limit=100`]);
  });

  it('renders LoadError when the read fails', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500, 'documents down'));
    const { default: ResparkableDocumentsPage } =
      await import('@/app/(resparkable)/resparkable/documents/page');

    render(await ResparkableDocumentsPage());

    expect(screen.getByRole('alert')).toHaveTextContent('documents down');
  });

  it('forwards documents to DocumentsView on success', async () => {
    const documents = [{ id: 'd1', title: 'Doc' }];
    vi.mocked(readResparkable).mockResolvedValue(ok(documents));
    const { default: ResparkableDocumentsPage } =
      await import('@/app/(resparkable)/resparkable/documents/page');

    render(await ResparkableDocumentsPage());

    const view = screen.getByTestId('documents-view');
    expect(view.getAttribute('data-props')).toBe(JSON.stringify({ documents }));
  });
});

// ─── Boards ───────────────────────────────────────────────────────────────────

describe('ResparkableBoardsPage', () => {
  it('reads boards, active projects and tags concurrently', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableBoardsPage } =
      await import('@/app/(resparkable)/resparkable/boards/page');

    await ResparkableBoardsPage();

    expect(callPaths()).toEqual([
      `${RESPARKABLE_API.BOARDS}?limit=100`,
      `${RESPARKABLE_API.PROJECTS}?status=active&limit=200`,
      `${RESPARKABLE_API.TAGS}?limit=100`,
    ]);
  });

  it('renders LoadError when the boards read fails', async () => {
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.BOARDS) ? fail(500, 'boards down') : ok([])
    );
    const { default: ResparkableBoardsPage } =
      await import('@/app/(resparkable)/resparkable/boards/page');

    render(await ResparkableBoardsPage());

    expect(screen.getByRole('alert')).toHaveTextContent('boards down');
    expect(screen.queryByTestId('boards-list')).not.toBeInTheDocument();
  });

  it('degrades projects and tags independently when their reads fail', async () => {
    const boards = [{ id: 'b1' }];
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.BOARDS) ? ok(boards) : fail(500, 'down')
    );
    const { default: ResparkableBoardsPage } =
      await import('@/app/(resparkable)/resparkable/boards/page');

    render(await ResparkableBoardsPage());

    const view = screen.getByTestId('boards-list');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      boards: unknown[];
      projects: unknown[];
      tags: unknown[];
    };
    expect(props.boards).toEqual(boards);
    expect(props.projects).toEqual([]);
    expect(props.tags).toEqual([]);
  });

  it('forwards the actual projects and tags data when both secondary reads succeed', async () => {
    const boards = [{ id: 'b1' }];
    const projects = [{ id: 'p1', name: 'Q4 launch' }];
    const tags = [{ id: 't1', name: 'urgent' }];
    vi.mocked(readResparkable).mockImplementation(async (path) => {
      if (path.startsWith(RESPARKABLE_API.BOARDS)) return ok(boards);
      if (path.startsWith(RESPARKABLE_API.PROJECTS)) return ok(projects);
      return ok(tags);
    });
    const { default: ResparkableBoardsPage } =
      await import('@/app/(resparkable)/resparkable/boards/page');

    render(await ResparkableBoardsPage());

    const view = screen.getByTestId('boards-list');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      boards: unknown[];
      projects: unknown[];
      tags: unknown[];
    };
    expect(props.boards).toEqual(boards);
    expect(props.projects).toEqual(projects);
    expect(props.tags).toEqual(tags);
  });
});

// ─── Shared with me ─────────────────────────────────────────────────────────

describe('ResparkableSharedPage', () => {
  it('reads the shared endpoint', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableSharedPage } =
      await import('@/app/(resparkable)/resparkable/shared/page');

    await ResparkableSharedPage();

    expect(callPaths()).toEqual([RESPARKABLE_API.SHARED]);
  });

  it('renders LoadError when the read fails', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500, 'shared down'));
    const { default: ResparkableSharedPage } =
      await import('@/app/(resparkable)/resparkable/shared/page');

    render(await ResparkableSharedPage());

    expect(screen.getByRole('alert')).toHaveTextContent('shared down');
    expect(screen.queryByTestId('shared-with-me-view')).not.toBeInTheDocument();
  });

  it('renders the view with the resolved items on success', async () => {
    const items = [{ item: { id: 'p1' }, owner: { id: 'user_owner' } }];
    vi.mocked(readResparkable).mockResolvedValue(ok(items));
    const { default: ResparkableSharedPage } =
      await import('@/app/(resparkable)/resparkable/shared/page');

    render(await ResparkableSharedPage());

    const view = screen.getByTestId('shared-with-me-view');
    expect(view.getAttribute('data-props')).toBe(JSON.stringify({ items }));
  });
});
