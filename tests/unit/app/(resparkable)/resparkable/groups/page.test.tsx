// @vitest-environment happy-dom

/**
 * Unit Tests: `ResparkableGroupsPage` (server component).
 *
 * Two concurrent reads, per the page's own docblock: the session, for the
 * viewer id, and the groups list, keyed on the actor rather than a
 * workspace. A failed list read renders `<LoadError>`; there is no 404
 * branch here, unlike the detail page, because "your groups" cannot 404 for
 * you.
 *
 * `GroupsView` is mocked to a props-dumping marker so this file stays about
 * the page's own read/branch logic, the same approach
 * `groups/[id]/page.test.tsx` takes for `GroupDetail`.
 *
 * @see app/(resparkable)/resparkable/groups/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { GroupListItemWire } from '@/lib/framework/resparkable/ui/payloads';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/framework/resparkable/ui/server-read', () => ({
  readResparkable: vi.fn(),
}));

vi.mock('@/lib/auth/utils', () => ({ getServerSession: vi.fn() }));

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    // LoadError (rendered on a failed read) calls useRouter() for its retry
    // button.
    useRouter: vi.fn(() => createMockRouter()),
  };
});

vi.mock('@/components/resparkable/groups/groups-view', () => ({
  GroupsView: (props: Record<string, unknown>) => (
    <div data-testid="groups-view" data-props={JSON.stringify(props)} />
  ),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';
import { getServerSession } from '@/lib/auth/utils';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

function fail(
  status: number | null,
  message = 'boom'
): { ok: false; status: number | null; message: string } {
  return { ok: false, status, message };
}

const GROUPS: GroupListItemWire[] = [
  {
    groupId: 'grp_1',
    name: 'Study Group B',
    slug: 'study-group-b',
    description: 'Thursday evenings',
    spaceId: 'spc_group_1',
    role: 'member',
    joinedAt: '2026-09-01T10:00:00.000Z',
  },
];

function propsOf(): Record<string, unknown> {
  const node = screen.getByTestId('groups-view');
  return JSON.parse(node.getAttribute('data-props') ?? '{}');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'user_a' } } as never);
});

describe('ResparkableGroupsPage', () => {
  it('reads the session and the groups list in parallel', async () => {
    vi.mocked(readResparkable).mockResolvedValue(ok(GROUPS));
    const { default: ResparkableGroupsPage } =
      await import('@/app/(resparkable)/resparkable/groups/page');

    await ResparkableGroupsPage();

    expect(getServerSession).toHaveBeenCalled();
    expect(readResparkable).toHaveBeenCalledWith(RESPARKABLE_API.GROUPS, expect.anything(), null);
  });

  it('renders LoadError when the list read fails', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500, 'groups unwell'));
    const { default: ResparkableGroupsPage } =
      await import('@/app/(resparkable)/resparkable/groups/page');

    render(await ResparkableGroupsPage());

    expect(screen.getByRole('alert')).toHaveTextContent('groups unwell');
    expect(screen.queryByTestId('groups-view')).not.toBeInTheDocument();
  });

  it('passes the list through to GroupsView as initial on success', async () => {
    vi.mocked(readResparkable).mockResolvedValue(ok(GROUPS));
    const { default: ResparkableGroupsPage } =
      await import('@/app/(resparkable)/resparkable/groups/page');

    render(await ResparkableGroupsPage());

    expect(propsOf().initial).toEqual(GROUPS);
  });

  it('reads the session for the viewer id, and passes it through', async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'user_z' } } as never);
    vi.mocked(readResparkable).mockResolvedValue(ok(GROUPS));
    const { default: ResparkableGroupsPage } =
      await import('@/app/(resparkable)/resparkable/groups/page');

    render(await ResparkableGroupsPage());

    expect(propsOf().viewerUserId).toBe('user_z');
  });

  it('passes an empty string for viewerUserId when there is no session', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    vi.mocked(readResparkable).mockResolvedValue(ok(GROUPS));
    const { default: ResparkableGroupsPage } =
      await import('@/app/(resparkable)/resparkable/groups/page');

    render(await ResparkableGroupsPage());

    expect(propsOf().viewerUserId).toBe('');
  });
});
