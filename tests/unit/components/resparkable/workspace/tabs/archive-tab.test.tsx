/**
 * Unit Tests: ArchiveTab.
 *
 * ArchiveTab's own logic (everything `useTabFetch` and the shared
 * `TabContent`/`TabLoadError` machinery doesn't already cover) is: only the
 * stale digest is load-bearing — the other five sections fail
 * independently and render their own "could not be loaded" copy rather
 * than taking the whole tab down — and three row-mapping functions
 * (`fromNamed`, `withTitle`, `fromThought`) that convert each collection's
 * wire shape into `ArchivedList`'s common `{id, title, archivedAt,
 * archivedReason}` item shape. `StaleDigest` and `ArchivedList` are mocked
 * to props-dumping markers so this file stays about ArchiveTab's own
 * mapping/dispatch, not either component's own rendering.
 *
 * @see components/resparkable/workspace/tabs/archive-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ArchiveTab } from '@/components/resparkable/workspace/tabs/archive-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/lifecycle/stale-digest', () => ({
  StaleDigest: (props: Record<string, unknown>) => (
    <div data-testid="stale-digest">{JSON.stringify(props)}</div>
  ),
}));

vi.mock('@/components/resparkable/lifecycle/archived-list', () => ({
  ArchivedList: (props: Record<string, unknown>) => (
    <div data-testid={`archived-list-${(props.noun as string).replace(/\s+/g, '-')}`}>
      {JSON.stringify(props)}
    </div>
  ),
}));

const digestFixture = { generatedAt: '2024-01-01T00:00:00.000Z', sections: [], total: 0 };

function namedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'proj_1',
    name: 'Old Project',
    slug: 'old-project',
    description: null,
    status: 'archived',
    areaId: null,
    priorityScore: 0,
    lastActivityAt: null,
    closedAt: null,
    snoozedUntil: null,
    archivedAt: '2024-02-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function titledRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'goal_1',
    title: 'Old Goal',
    description: null,
    horizon: 'year',
    parentGoalId: null,
    areaId: null,
    targetDate: null,
    status: 'archived',
    lastActivityAt: null,
    archivedAt: '2024-02-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function thoughtRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'thought_1',
    content: 'A quick note',
    source: 'manual',
    status: 'archived',
    promotedToType: null,
    promotedToId: null,
    snoozedUntil: null,
    snoozeCount: 0,
    archivedAt: '2024-02-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Routes a mocked `apiClient.get` call to the right fixture by collection. */
function mockEndpoints(responses: {
  digest?: Record<string, unknown> | Error;
  projects?: unknown[] | Error;
  goals?: unknown[] | Error;
  tasks?: unknown[] | Error;
  thoughts?: unknown[] | Error;
  entities?: unknown[] | Error;
}) {
  vi.mocked(apiClient.get).mockImplementation((endpoint: string) => {
    const pick = (value: unknown, fallback: unknown) =>
      value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? fallback);
    if (endpoint === RESPARKABLE_API.STALE) return pick(responses.digest, digestFixture);
    if (endpoint.startsWith(RESPARKABLE_API.PROJECTS)) return pick(responses.projects, []);
    if (endpoint.startsWith(RESPARKABLE_API.GOALS)) return pick(responses.goals, []);
    if (endpoint.startsWith(RESPARKABLE_API.TASKS)) return pick(responses.tasks, []);
    if (endpoint.startsWith(RESPARKABLE_API.THOUGHTS)) return pick(responses.thoughts, []);
    if (endpoint.startsWith(RESPARKABLE_API.ENTITIES)) return pick(responses.entities, []);
    return Promise.reject(new Error(`unexpected endpoint: ${endpoint}`));
  });
}

function rendered(testId: string) {
  return JSON.parse(screen.getByTestId(testId).textContent ?? '{}');
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe('ArchiveTab', () => {
  it('shows a labelled loading state before the digest resolves', () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    render(<ArchiveTab />);

    expect(screen.getByText('Loading archive')).toBeInTheDocument();
  });

  it('renders TabLoadError and retries when the digest — the only load-bearing fetch — fails', async () => {
    const user = userEvent.setup();
    mockEndpoints({ digest: new APIClientError('Digest unavailable.', 'ERR', 500) });

    render(<ArchiveTab />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('Digest unavailable.')).toBeInTheDocument();
    expect(screen.getByText(/Couldn.t load what has gone quiet/)).toBeInTheDocument();

    mockEndpoints({ digest: digestFixture });
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByTestId('stale-digest')).toBeInTheDocument());
  });

  it('maps a project row (name → title) for the projects ArchivedList', async () => {
    mockEndpoints({
      digest: digestFixture,
      projects: [namedRow({ id: 'proj_9', name: 'Sunset Feature', archivedReason: 'manual' })],
    });

    render(<ArchiveTab />);

    await waitFor(() => expect(screen.getByTestId('archived-list-project')).toBeInTheDocument());
    expect(rendered('archived-list-project').items).toEqual([
      {
        id: 'proj_9',
        title: 'Sunset Feature',
        archivedAt: '2024-02-01T00:00:00.000Z',
        archivedReason: 'manual',
      },
    ]);
  });

  it('maps a goal row (title stays title) for the goals ArchivedList', async () => {
    mockEndpoints({
      digest: digestFixture,
      goals: [titledRow({ id: 'goal_9', title: 'Ship v2' })],
    });

    render(<ArchiveTab />);

    await waitFor(() => expect(screen.getByTestId('archived-list-goal')).toBeInTheDocument());
    expect(rendered('archived-list-goal').items).toEqual([
      {
        id: 'goal_9',
        title: 'Ship v2',
        archivedAt: '2024-02-01T00:00:00.000Z',
        archivedReason: null,
      },
    ]);
  });

  it('maps a task row for the tasks ArchivedList, defaulting a missing archivedReason to null', async () => {
    mockEndpoints({
      digest: digestFixture,
      tasks: [
        {
          id: 'task_9',
          title: 'File the report',
          notes: null,
          projectId: null,
          status: 'archived',
          dueAt: null,
          deferUntil: null,
          estimateMinutes: null,
          energy: null,
          contextTag: null,
          priorityScore: 0,
          priorityFactors: null,
          manualBoost: 0,
          manualBoostExpiresAt: null,
          manualBoostReason: null,
          snoozeCount: 0,
          completedAt: null,
          archivedAt: '2024-02-01T00:00:00.000Z',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          // archivedReason omitted entirely
        },
      ],
    });

    render(<ArchiveTab />);

    await waitFor(() => expect(screen.getByTestId('archived-list-task')).toBeInTheDocument());
    expect(rendered('archived-list-task').items).toEqual([
      {
        id: 'task_9',
        title: 'File the report',
        archivedAt: '2024-02-01T00:00:00.000Z',
        archivedReason: null,
      },
    ]);
  });

  it('maps an entity row (name → title) for the "people or company" ArchivedList', async () => {
    mockEndpoints({
      digest: digestFixture,
      entities: [
        {
          id: 'ent_9',
          name: 'Acme Corp',
          slug: 'acme-corp',
          kind: 'company',
          description: null,
          website: null,
          status: 'archived',
          lastActivityAt: null,
          snoozedUntil: null,
          archivedAt: '2024-02-01T00:00:00.000Z',
          archivedReason: 'aged_out',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
    });

    render(<ArchiveTab />);

    await waitFor(() =>
      expect(screen.getByTestId('archived-list-person-or-company')).toBeInTheDocument()
    );
    expect(rendered('archived-list-person-or-company').items).toEqual([
      {
        id: 'ent_9',
        title: 'Acme Corp',
        archivedAt: '2024-02-01T00:00:00.000Z',
        archivedReason: 'aged_out',
      },
    ]);
  });

  it('uses a thought’s first line as its title, truncated past 120 characters', async () => {
    const longFirstLine = 'x'.repeat(130);
    mockEndpoints({
      digest: digestFixture,
      thoughts: [
        thoughtRow({ id: 'thought_long', content: `${longFirstLine}\nsecond line ignored` }),
      ],
    });

    render(<ArchiveTab />);

    await waitFor(() => expect(screen.getByTestId('archived-list-note')).toBeInTheDocument());
    const items = rendered('archived-list-note').items as Array<{ title: string }>;
    expect(items[0].title).toBe(`${'x'.repeat(120)}…`);
  });

  it('titles an empty thought "Empty note" rather than a blank string', async () => {
    mockEndpoints({
      digest: digestFixture,
      thoughts: [thoughtRow({ id: 'thought_empty', content: '' })],
    });

    render(<ArchiveTab />);

    await waitFor(() => expect(screen.getByTestId('archived-list-note')).toBeInTheDocument());
    const items = rendered('archived-list-note').items as Array<{ title: string }>;
    expect(items[0].title).toBe('Empty note');
  });

  it('does not truncate a thought whose first line is exactly 120 characters', async () => {
    const exactLine = 'y'.repeat(120);
    mockEndpoints({
      digest: digestFixture,
      thoughts: [thoughtRow({ id: 'thought_exact', content: exactLine })],
    });

    render(<ArchiveTab />);

    await waitFor(() => expect(screen.getByTestId('archived-list-note')).toBeInTheDocument());
    const items = rendered('archived-list-note').items as Array<{ title: string }>;
    expect(items[0].title).toBe(exactLine);
  });

  it('shows the "no archived X" empty label when a section is ready but empty', async () => {
    mockEndpoints({ digest: digestFixture, projects: [] });

    render(<ArchiveTab />);

    await waitFor(() => expect(screen.getByTestId('archived-list-project')).toBeInTheDocument());
    expect(rendered('archived-list-project').emptyLabel).toBe('No archived projects.');
  });

  it('defaults archivedReason to null (fromNamed) when the API omits it entirely', async () => {
    // namedRow() itself never sets archivedReason unless overridden, so this
    // exercises exactly the "field absent from the wire response" case.
    mockEndpoints({ digest: digestFixture, projects: [namedRow({ id: 'proj_no_reason' })] });

    render(<ArchiveTab />);

    await waitFor(() => expect(screen.getByTestId('archived-list-project')).toBeInTheDocument());
    expect(rendered('archived-list-project').items).toEqual([
      {
        id: 'proj_no_reason',
        title: 'Old Project',
        archivedAt: '2024-02-01T00:00:00.000Z',
        archivedReason: null,
      },
    ]);
  });

  it('renders every other archive section — and their own "could not be loaded" copy — when one section fails, without failing the whole tab', async () => {
    mockEndpoints({
      digest: digestFixture,
      projects: new APIClientError('Projects endpoint down.', 'ERR', 500),
      goals: [titledRow({ id: 'goal_1' })],
    });

    render(<ArchiveTab />);

    // The tab itself renders (digest is the only load-bearing fetch).
    await waitFor(() => expect(screen.getByTestId('stale-digest')).toBeInTheDocument());

    expect(rendered('archived-list-project').items).toEqual([]);
    expect(rendered('archived-list-project').emptyLabel).toBe(
      'Archived projects could not be loaded.'
    );

    // A sibling section that succeeded is unaffected.
    expect(rendered('archived-list-goal').items).toHaveLength(1);
    expect(rendered('archived-list-goal').emptyLabel).toBe('No archived goals.');
  });

  it('shows "could not be loaded" copy for goals, tasks, notes, and people/companies when each fails independently', async () => {
    mockEndpoints({
      digest: digestFixture,
      projects: [namedRow()],
      goals: new APIClientError('Goals down.', 'ERR', 500),
      tasks: new APIClientError('Tasks down.', 'ERR', 500),
      thoughts: new APIClientError('Thoughts down.', 'ERR', 500),
      entities: new APIClientError('Entities down.', 'ERR', 500),
    });

    render(<ArchiveTab />);

    await waitFor(() => expect(screen.getByTestId('archived-list-project')).toBeInTheDocument());

    // Projects succeeded, so its label stays the "ready but empty" wording — a
    // contrast case for the four sections below that actually failed.
    expect(rendered('archived-list-project').items).toEqual([
      {
        id: 'proj_1',
        title: 'Old Project',
        archivedAt: '2024-02-01T00:00:00.000Z',
        archivedReason: null,
      },
    ]);

    expect(rendered('archived-list-goal').items).toEqual([]);
    expect(rendered('archived-list-goal').emptyLabel).toBe('Archived goals could not be loaded.');

    expect(rendered('archived-list-task').items).toEqual([]);
    expect(rendered('archived-list-task').emptyLabel).toBe('Archived tasks could not be loaded.');

    expect(rendered('archived-list-note').items).toEqual([]);
    expect(rendered('archived-list-note').emptyLabel).toBe('Archived notes could not be loaded.');

    expect(rendered('archived-list-person-or-company').items).toEqual([]);
    expect(rendered('archived-list-person-or-company').emptyLabel).toBe(
      'These could not be loaded.'
    );
  });

  it('passes the digest straight through to StaleDigest', async () => {
    const digest = { generatedAt: '2024-03-01T00:00:00.000Z', sections: [], total: 7 };
    mockEndpoints({ digest });

    render(<ArchiveTab />);

    await waitFor(() => expect(screen.getByTestId('stale-digest')).toBeInTheDocument());
    expect(rendered('stale-digest').digest).toEqual(digest);
  });
});
