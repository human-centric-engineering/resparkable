// @vitest-environment happy-dom

/**
 * Unit Tests: `ResparkableGroupPage` (server component).
 *
 * Three concurrent reads, per the page's own docblock: the detail, the
 * budget, and, only for an admin and only once the detail is known, the
 * invites. A 404 on the detail becomes `notFound()`; any other failure renders
 * `<LoadError>` and the page still works. A failed budget read costs the
 * page its credits section (`budget={null}`), not the page itself.
 *
 * `GroupDetail` is mocked to a props-dumping marker so this file stays about
 * the page's own read/branch logic, the same approach `pages.detail.test.tsx`
 * takes for `ProjectDetail`/`EntityDetail`/`BoardView`.
 *
 * @see app/(resparkable)/resparkable/groups/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type {
  GroupBudgetWire,
  GroupDetailWire,
  GroupInviteWire,
  GroupJoinLinkWire,
} from '@/lib/framework/resparkable/ui/payloads';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/framework/resparkable/ui/server-read', () => ({
  readResparkable: vi.fn(),
}));

vi.mock('@/lib/auth/utils', () => ({ getServerSession: vi.fn() }));

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    notFound: vi.fn(() => {
      throw new Error('NEXT_NOT_FOUND');
    }),
    // LoadError (rendered on non-404 failures) calls useRouter() for its retry
    // button.
    useRouter: vi.fn(() => createMockRouter()),
  };
});

vi.mock('@/components/resparkable/groups/group-detail', () => ({
  GroupDetail: (props: Record<string, unknown>) => (
    <div data-testid="group-detail" data-props={JSON.stringify(props)} />
  ),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';
import { getServerSession } from '@/lib/auth/utils';
import { notFound } from 'next/navigation';

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

function detailFixture(overrides: Partial<GroupDetailWire> = {}): GroupDetailWire {
  return {
    group: {
      groupId: 'group_1',
      name: 'Study Group',
      slug: 'study-group',
      description: null,
      spaceId: 'grp_space_1',
      maxMembers: 50,
      viewersCanInheritAdmin: true,
      joinRefusedFullAt: null,
    },
    yourRole: 'member',
    members: [],
    latestDigest: null,
    ...overrides,
  };
}

function budgetFixture(overrides: Partial<GroupBudgetWire> = {}): GroupBudgetWire {
  return {
    balanceCredits: 40,
    fundingMode: 'self_funded',
    canTopUp: true,
    yourPersonalBalanceCredits: 10,
    you: { dailyCreditCap: null, spentLastDayCredits: 0 },
    admin: null,
    ...overrides,
  };
}

const INVITES: GroupInviteWire[] = [
  {
    id: 'invite_1',
    email: 'friend@example.com',
    role: 'member',
    invitedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    acceptedAt: null,
  },
];

const JOIN_LINKS: GroupJoinLinkWire[] = [
  {
    id: 'link_1',
    tokenPrefix: 'abc123',
    role: 'member',
    approval: 'request',
    maxUses: null,
    useCount: 0,
    expiresAt: null,
    revokedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

/** Routes the mocked `readResparkable` by the exact path the page asked for. */
function routeReads(
  map: Record<
    string,
    { ok: true; data: unknown } | { ok: false; status: number | null; message: string }
  >
) {
  vi.mocked(readResparkable).mockImplementation(async (path: string) => {
    const result = map[path];
    if (!result) throw new Error(`unexpected read: ${path}`);
    return result;
  });
}

function propsOf(): Record<string, unknown> {
  const node = screen.getByTestId('group-detail');
  return JSON.parse(node.getAttribute('data-props') ?? '{}');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'user_a' } } as never);
});

describe('ResparkableGroupPage', () => {
  it('calls notFound() when the detail read 404s, and does not render LoadError', async () => {
    routeReads({
      [RESPARKABLE_API.group('missing')]: fail(404, 'not found'),
      [RESPARKABLE_API.groupBudget('missing')]: ok(budgetFixture()),
    });
    const { default: ResparkableGroupPage } =
      await import('@/app/(resparkable)/resparkable/groups/[id]/page');

    await expect(
      ResparkableGroupPage({ params: Promise.resolve({ id: 'missing' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('renders LoadError (not notFound) when the detail read fails with a non-404 status', async () => {
    routeReads({
      [RESPARKABLE_API.group('group_1')]: fail(500, 'server unwell'),
      [RESPARKABLE_API.groupBudget('group_1')]: ok(budgetFixture()),
    });
    const { default: ResparkableGroupPage } =
      await import('@/app/(resparkable)/resparkable/groups/[id]/page');

    render(await ResparkableGroupPage({ params: Promise.resolve({ id: 'group_1' }) }));

    expect(screen.getByRole('alert')).toHaveTextContent('server unwell');
    expect(notFound).not.toHaveBeenCalled();
  });

  it('reads the invites and join links for an admin', async () => {
    routeReads({
      [RESPARKABLE_API.group('group_1')]: ok(detailFixture({ yourRole: 'admin' })),
      [RESPARKABLE_API.groupBudget('group_1')]: ok(budgetFixture()),
      [RESPARKABLE_API.groupInvites('group_1')]: ok(INVITES),
      [RESPARKABLE_API.groupJoinLinks('group_1')]: ok(JOIN_LINKS),
    });
    const { default: ResparkableGroupPage } =
      await import('@/app/(resparkable)/resparkable/groups/[id]/page');

    render(await ResparkableGroupPage({ params: Promise.resolve({ id: 'group_1' }) }));

    const paths = vi.mocked(readResparkable).mock.calls.map((call) => call[0]);
    expect(paths).toContain(RESPARKABLE_API.groupInvites('group_1'));
    expect(paths).toContain(RESPARKABLE_API.groupJoinLinks('group_1'));
    expect(propsOf().invites).toEqual(INVITES);
    expect(propsOf().joinLinks).toEqual(JOIN_LINKS);
  });

  it('does not read the invites or join links for a non-admin, and passes empty lists', async () => {
    routeReads({
      [RESPARKABLE_API.group('group_1')]: ok(detailFixture({ yourRole: 'member' })),
      [RESPARKABLE_API.groupBudget('group_1')]: ok(budgetFixture()),
    });
    const { default: ResparkableGroupPage } =
      await import('@/app/(resparkable)/resparkable/groups/[id]/page');

    render(await ResparkableGroupPage({ params: Promise.resolve({ id: 'group_1' }) }));

    const paths = vi.mocked(readResparkable).mock.calls.map((call) => call[0]);
    expect(paths).not.toContain(RESPARKABLE_API.groupInvites('group_1'));
    expect(paths).not.toContain(RESPARKABLE_API.groupJoinLinks('group_1'));
    expect(propsOf().invites).toEqual([]);
    expect(propsOf().joinLinks).toEqual([]);
  });

  it('passes an empty join-link list to GroupDetail when the read fails, without failing the page', async () => {
    routeReads({
      [RESPARKABLE_API.group('group_1')]: ok(detailFixture({ yourRole: 'admin' })),
      [RESPARKABLE_API.groupBudget('group_1')]: ok(budgetFixture()),
      [RESPARKABLE_API.groupInvites('group_1')]: ok(INVITES),
      [RESPARKABLE_API.groupJoinLinks('group_1')]: fail(500, 'join links unwell'),
    });
    const { default: ResparkableGroupPage } =
      await import('@/app/(resparkable)/resparkable/groups/[id]/page');

    render(await ResparkableGroupPage({ params: Promise.resolve({ id: 'group_1' }) }));

    expect(screen.getByTestId('group-detail')).toBeInTheDocument();
    expect(propsOf().joinLinks).toEqual([]);
  });

  it('passes budget={null} to GroupDetail when the budget read fails', async () => {
    routeReads({
      [RESPARKABLE_API.group('group_1')]: ok(detailFixture()),
      [RESPARKABLE_API.groupBudget('group_1')]: fail(500, 'budget unwell'),
    });
    const { default: ResparkableGroupPage } =
      await import('@/app/(resparkable)/resparkable/groups/[id]/page');

    render(await ResparkableGroupPage({ params: Promise.resolve({ id: 'group_1' }) }));

    // The group still renders: a failed budget read costs the page its
    // credits section, not the whole page.
    expect(screen.getByTestId('group-detail')).toBeInTheDocument();
    expect(propsOf().budget).toBeNull();
  });

  it('passes the budget through to GroupDetail on success', async () => {
    const budget = budgetFixture({ balanceCredits: 77 });
    routeReads({
      [RESPARKABLE_API.group('group_1')]: ok(detailFixture()),
      [RESPARKABLE_API.groupBudget('group_1')]: ok(budget),
    });
    const { default: ResparkableGroupPage } =
      await import('@/app/(resparkable)/resparkable/groups/[id]/page');

    render(await ResparkableGroupPage({ params: Promise.resolve({ id: 'group_1' }) }));

    expect(propsOf().budget).toEqual(budget);
  });

  it('reads the session for the viewer id, and passes it through', async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'user_z' } } as never);
    routeReads({
      [RESPARKABLE_API.group('group_1')]: ok(detailFixture()),
      [RESPARKABLE_API.groupBudget('group_1')]: ok(budgetFixture()),
    });
    const { default: ResparkableGroupPage } =
      await import('@/app/(resparkable)/resparkable/groups/[id]/page');

    render(await ResparkableGroupPage({ params: Promise.resolve({ id: 'group_1' }) }));

    expect(propsOf().viewerUserId).toBe('user_z');
  });
});
