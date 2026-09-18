/**
 * Unit Tests: the switcher's list (phase 47).
 *
 *   1. **Personal is always first and always present**, including for an
 *      account that has never touched Resparkable and has no space row. A
 *      switcher whose first entry appears only after you have used the product
 *      is missing on the one day that would be most confusing.
 *   2. **Reading the list is not a write.** Creating the row here would mean
 *      rendering the shell provisions a brain for every visitor who bounced.
 *   3. **A pending membership is not a workspace.** Showing it and 404ing on
 *      the click is worse than not showing it.
 *   4. **Groups are sorted by name**, so the list does not reorder itself
 *      between page loads.
 *
 * @see lib/framework/resparkable/services/spaces.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/services/space', () => ({
  getResparkableSpace: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/membership', () => ({
  listGroupsForActor: vi.fn(),
}));

import { listGroupsForActor } from '@/lib/framework/resparkable/services/membership';
import { getResparkableSpace } from '@/lib/framework/resparkable/services/space';
import { listOpenableSpaces } from '@/lib/framework/resparkable/services/spaces';

const NOW = new Date('2026-09-01T10:00:00.000Z');

function membership(overrides: Record<string, unknown> = {}) {
  const group = {
    id: 'grp_1',
    name: 'Study Group B',
    slug: 'study-group-b',
    description: null,
    spaceId: 'spc_group_1',
    maxMembers: 50,
    createdAt: NOW,
    updatedAt: NOW,
    ...((overrides.group as Record<string, unknown>) ?? {}),
  };
  return {
    id: 'mem_1',
    groupId: group.id,
    userId: 'user_a',
    role: 'member',
    invitedByUserId: null,
    joinedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
    group,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getResparkableSpace).mockResolvedValue(null);
  vi.mocked(listGroupsForActor).mockResolvedValue([]);
});

describe('listOpenableSpaces', () => {
  it('offers the personal space to somebody who has never used the product', async () => {
    const spaces = await listOpenableSpaces('user_a');

    // No space row exists yet, and this does not create one: the id IS the
    // space key, and `ensureResparkableSpace` writes the row on first use.
    expect(spaces).toEqual([
      { spaceId: 'user_a', name: 'Personal', kind: 'personal', role: 'owner', groupId: null },
    ]);
  });

  it('uses the space name once one has been set', async () => {
    vi.mocked(getResparkableSpace).mockResolvedValue({ name: 'My brain' } as never);

    expect((await listOpenableSpaces('user_a'))[0].name).toBe('My brain');
  });

  it('puts personal first and groups after it, by name', async () => {
    vi.mocked(listGroupsForActor).mockResolvedValue([
      membership({ group: { id: 'grp_1', name: 'Study Group B', spaceId: 'spc_1' } }),
      membership({ group: { id: 'grp_2', name: 'Allotment', spaceId: 'spc_2' } }),
    ] as never);

    const spaces = await listOpenableSpaces('user_a');

    // Sorted rather than left in query order, so the switcher does not
    // reshuffle itself between page loads.
    expect(spaces.map((space) => space.name)).toEqual(['Personal', 'Allotment', 'Study Group B']);
  });

  it('carries the group id so the switcher can reach its member list', async () => {
    vi.mocked(listGroupsForActor).mockResolvedValue([membership()] as never);

    expect((await listOpenableSpaces('user_a'))[1]).toMatchObject({
      spaceId: 'spc_group_1',
      kind: 'group',
      role: 'member',
      groupId: 'grp_1',
    });
  });

  it('leaves out a membership that is still pending', async () => {
    vi.mocked(listGroupsForActor).mockResolvedValue([membership({ joinedAt: null })] as never);

    // Phase 57's request-to-join. It resolves to no scope, so an entry for it
    // would be a row that 404s when clicked.
    expect(await listOpenableSpaces('user_a')).toHaveLength(1);
  });

  it('never labels a group workspace as owned', async () => {
    vi.mocked(listGroupsForActor).mockResolvedValue([membership({ role: 'owner' })] as never);

    // §23.2: `owner` means "the sole human who owns this space" and a group has
    // none. An unrecognised role reads as the least it could be.
    expect((await listOpenableSpaces('user_a'))[1].role).toBe('viewer');
  });

  it('returns nothing at all without an actor', async () => {
    expect(await listOpenableSpaces('')).toEqual([]);
    expect(getResparkableSpace).not.toHaveBeenCalled();
  });
});
