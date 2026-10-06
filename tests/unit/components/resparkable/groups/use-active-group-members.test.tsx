// @vitest-environment happy-dom

/**
 * Unit Tests: the open group's members, for the assignee picker and the feed
 * (phase 58). One read for the workspace list and one for its members, and
 * nothing at all in a personal workspace.
 *
 * @see components/resparkable/groups/use-active-group-members.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@/lib/framework/resparkable/ui/use-active-space', () => ({ useActiveSpaceId: vi.fn() }));
vi.mock('@/components/resparkable/workspace/tabs/use-tab-fetch', () => ({ useTabFetch: vi.fn() }));

import {
  memberName,
  useActiveGroupMembers,
} from '@/components/resparkable/groups/use-active-group-members';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { useActiveSpaceId } from '@/lib/framework/resparkable/ui/use-active-space';

const JOINED = {
  userId: 'u1',
  name: 'Sam',
  role: 'member',
  joinedAt: '2026-09-01T00:00:00.000Z',
  requestedAt: null,
};
const PENDING = {
  userId: 'u2',
  name: 'Kim',
  role: 'member',
  joinedAt: null,
  requestedAt: '2026-09-02T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useActiveGroupMembers', () => {
  it('reads nothing and returns nothing in a personal workspace', () => {
    vi.mocked(useActiveSpaceId).mockReturnValue(null);
    vi.mocked(useTabFetch).mockReturnValue([{ status: 'loading' }, vi.fn()]);

    const { result } = renderHook(() => useActiveGroupMembers());

    expect(result.current).toBeNull();
    expect(vi.mocked(useTabFetch).mock.calls.every(([endpoint]) => endpoint === null)).toBe(true);
  });

  it('returns the joined members of the open group, never a request to join', () => {
    vi.mocked(useActiveSpaceId).mockReturnValue('spc_g');
    vi.mocked(useTabFetch).mockImplementation((endpoint) =>
      endpoint === '/api/v1/resparkable/spaces'
        ? [{ status: 'ready', data: [{ spaceId: 'spc_g', groupId: 'grp_1' }] }, vi.fn()]
        : [{ status: 'ready', data: [JOINED, PENDING] }, vi.fn()]
    );

    const { result } = renderHook(() => useActiveGroupMembers());

    expect(result.current).toEqual([JOINED]);
    expect(
      vi
        .mocked(useTabFetch)
        .mock.calls.some(([endpoint]) => endpoint === '/api/v1/resparkable/groups/grp_1/members')
    ).toBe(true);
  });

  it('returns nothing until the members have loaded', () => {
    vi.mocked(useActiveSpaceId).mockReturnValue('spc_g');
    vi.mocked(useTabFetch).mockReturnValue([{ status: 'loading' }, vi.fn()]);

    expect(renderHook(() => useActiveGroupMembers()).result.current).toBeNull();
  });
});

describe('memberName', () => {
  it('uses the account name, and a plain stand-in when there is none, never an address', () => {
    expect(memberName(JOINED)).toBe('Sam');
    expect(memberName({ ...JOINED, name: null })).toBe('A member with no name set');
    expect(memberName(undefined)).toBe('A member with no name set');
  });
});
