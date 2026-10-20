/**
 * Unit Tests: a group's books (phase 62, decision 8; §23.12's second amendment).
 *
 * What is worth pinning:
 *
 *   - **Each ledger kind lands in one category, on one side.** A two-sided move
 *     (a top-up, a seat, a debt the pool takes on) writes a row for each account,
 *     and counting both would double the group's money.
 *   - **People are listed by name, never by amount**, so the books are an
 *     account and not a league table.
 *   - **Every current member is listed, even with nothing**, and everybody who
 *     has left is folded into one "Former members" line.
 *   - **Weeks run Monday to Sunday on the group's clock**, and the window is
 *     clamped to 1..52 weeks.
 *
 * @see lib/framework/resparkable/services/group-books.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listGroupLedgerSince = vi.fn();
const findCreditAccount = vi.fn();
const findAccountNames = vi.fn();
const listGroupMembers = vi.fn();
const findGroupWithClockBySpaceId = vi.fn();
const resolveGroupMembership = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/group-books', () => ({
  listGroupLedgerSince: (...args: unknown[]) => listGroupLedgerSince(...args),
}));
vi.mock('@/lib/framework/resparkable/repo/billing', () => ({
  findCreditAccount: (...args: unknown[]) => findCreditAccount(...args),
}));
vi.mock('@/lib/framework/resparkable/repo/groups', () => ({
  findAccountNames: (...args: unknown[]) => findAccountNames(...args),
  listGroupMembers: (...args: unknown[]) => listGroupMembers(...args),
}));
vi.mock('@/lib/framework/resparkable/repo/group-billing', () => ({
  findGroupWithClockBySpaceId: (...args: unknown[]) => findGroupWithClockBySpaceId(...args),
}));
vi.mock('@/lib/framework/resparkable/services/membership', () => ({
  resolveGroupMembership: (...args: unknown[]) => resolveGroupMembership(...args),
}));

import type { BooksLedgerRow } from '@/lib/framework/resparkable/repo/group-books';
import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import {
  BOOKS_CATEGORIES,
  DEFAULT_BOOKS_WEEKS,
  MAX_BOOKS_WEEKS,
  classifyLedgerRow,
  getGroupBooks,
} from '@/lib/framework/resparkable/services/group-books';

/** A Wednesday. In UTC its week began on Monday 19 October. */
const NOW = new Date('2026-10-21T12:00:00Z');
const THIS_WEEK = '2026-10-19T00:00:00.000Z';

function row(overrides: Partial<BooksLedgerRow>): BooksLedgerRow {
  return {
    kind: 'agent_spend',
    creditsDelta: -1,
    createdByUserId: null,
    memberUserId: null,
    booksCategory: null,
    createdAt: new Date('2026-10-20T09:00:00Z'),
    ...overrides,
  };
}

function member(userId: string, joinedAt: Date | null = new Date('2026-01-01')) {
  return { userId, role: 'member', joinedAt };
}

function setup(
  options: {
    role?: 'admin' | 'member' | 'viewer';
    rows?: BooksLedgerRow[];
    members?: ReturnType<typeof member>[];
    names?: Record<string, string | null>;
    timezone?: string | null;
    pool?: number | null;
  } = {}
) {
  const {
    role = 'member',
    rows = [],
    members = [],
    names = {},
    timezone = 'UTC',
    pool = 0,
  } = options;
  resolveGroupMembership.mockResolvedValue({
    scope: spaceScopeFor({ spaceId: 'spc_group', actorUserId: 'user_me', role }),
    membership: { group: { id: 'grp_1' } },
  });
  listGroupLedgerSince.mockResolvedValue(rows);
  listGroupMembers.mockResolvedValue(members);
  findAccountNames.mockResolvedValue(new Map(Object.entries(names)));
  findCreditAccount.mockResolvedValue(pool === null ? null : { balanceCredits: pool });
  findGroupWithClockBySpaceId.mockResolvedValue(timezone === null ? null : { timezone });
}

async function books(weeks?: number, now: Date = NOW) {
  const result = await getGroupBooks('user_me', 'grp_1', weeks, now);
  if (!result.ok) throw new Error('expected books');
  return result.value;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('classifyLedgerRow', () => {
  describe('a phase 62 row reads its stored category', () => {
    it.each([
      ['seats', 'member'],
      ['ownActivity', 'member'],
      ['creditedBack', 'member'],
      ['sharedActivity', 'author'],
      ['topUps', 'author'],
      ['debtsTakenOn', 'author'],
    ] as const)('%s is about the %s column’s person', (category, column) => {
      const meaning = classifyLedgerRow(
        row({
          kind: 'anything',
          creditsDelta: -3,
          createdByUserId: 'user_author',
          memberUserId: 'user_member',
          booksCategory: category,
        })
      );

      expect(meaning).toEqual({
        category,
        userId: column === 'member' ? 'user_member' : 'user_author',
        aboutPerson: true,
        credits: 3,
      });
    });

    it('skips the side of a two-sided move marked none', () => {
      expect(
        classifyLedgerRow(row({ kind: 'seat', creditsDelta: 4, booksCategory: 'none' }))
      ).toBeNull();
    });

    it('skips a category it does not know rather than guessing', () => {
      expect(classifyLedgerRow(row({ booksCategory: 'mystery' }))).toBeNull();
    });

    it('keeps an erased member’s seat as about a person, so it lands on Former members', () => {
      // Both person columns are SetNull: after erasure the member side of a seat
      // has neither, and only the stored category still says what it was.
      expect(
        classifyLedgerRow(row({ kind: 'seat', creditsDelta: -2, booksCategory: 'seats' }))
      ).toEqual({ category: 'seats', userId: null, aboutPerson: true, credits: 2 });
    });

    it('counts an erased member’s debt once, not once per side', () => {
      const memberSide = row({ kind: 'debt_absorbed', creditsDelta: 10, booksCategory: 'none' });
      const poolSide = row({
        kind: 'debt_absorbed',
        creditsDelta: -10,
        booksCategory: 'debtsTakenOn',
      });

      expect(classifyLedgerRow(memberSide)).toBeNull();
      expect(classifyLedgerRow(poolSide)).toMatchObject({ category: 'debtsTakenOn', credits: 10 });
    });

    it('makes a running cost the pool paid nobody’s, and one an admin paid theirs', () => {
      expect(classifyLedgerRow(row({ booksCategory: 'runningCosts' }))).toMatchObject({
        aboutPerson: false,
      });
      expect(
        classifyLedgerRow(row({ booksCategory: 'runningCostsOwn', memberUserId: 'user_admin' }))
      ).toEqual({ category: 'runningCosts', userId: 'user_admin', aboutPerson: true, credits: 1 });
    });

    it('keeps a running cost an erased admin paid on the Former members line', () => {
      // The admin's id is nulled by erasure; the stored category still says a
      // person paid it, so it does not turn into the pool's.
      expect(classifyLedgerRow(row({ booksCategory: 'runningCostsOwn' }))).toEqual({
        category: 'runningCosts',
        userId: null,
        aboutPerson: true,
        credits: 1,
      });
    });
  });

  describe('a row from before phase 62 is read from its kind', () => {
    it('calls a run nobody started a running cost that is nobody’s', () => {
      expect(classifyLedgerRow(row({ creditsDelta: -2 }))).toEqual({
        category: 'runningCosts',
        userId: null,
        aboutPerson: false,
        credits: 2,
      });
    });

    it('calls a run a member started shared activity, theirs', () => {
      expect(classifyLedgerRow(row({ createdByUserId: 'user_a', creditsDelta: -2 }))).toEqual({
        category: 'sharedActivity',
        userId: 'user_a',
        aboutPerson: true,
        credits: 2,
      });
    });

    it('calls a pool top-up added by its giver', () => {
      expect(
        classifyLedgerRow(row({ kind: 'transfer_in', creditsDelta: 5, createdByUserId: 'user_a' }))
      ).toMatchObject({ category: 'topUps', userId: 'user_a' });
    });

    it('counts an operator’s grant as added by nobody in the group', () => {
      expect(
        classifyLedgerRow(row({ kind: 'admin_grant', creditsDelta: 50, createdByUserId: null }))
      ).toEqual({ category: 'topUps', userId: null, aboutPerson: false, credits: 50 });
    });

    it('ignores zero-credit rows and kinds the books do not show', () => {
      expect(classifyLedgerRow(row({ creditsDelta: 0 }))).toBeNull();
      expect(classifyLedgerRow(row({ kind: 'refund', creditsDelta: 3 }))).toBeNull();
    });
  });
});

describe('getGroupBooks', () => {
  it('is not_a_member for a caller with no membership, and reads nothing', async () => {
    resolveGroupMembership.mockResolvedValue(null);

    const result = await getGroupBooks('user_x', 'grp_1', 12, NOW);

    expect(result).toEqual({ ok: false, reason: 'not_a_member' });
    expect(listGroupLedgerSince).not.toHaveBeenCalled();
    expect(findCreditAccount).not.toHaveBeenCalled();
  });

  it('lets a viewer read the books', async () => {
    setup({ role: 'viewer', members: [member('user_me')], names: { user_me: 'Me' } });

    const result = await getGroupBooks('user_me', 'grp_1', 12, NOW);

    expect(result.ok).toBe(true);
  });

  it('lists every current member, even one with no money moved, and marks the caller', async () => {
    setup({
      members: [member('user_me'), member('user_quiet')],
      names: { user_me: 'Me Myself', user_quiet: 'Quinn Quiet' },
      rows: [row({ createdByUserId: 'user_me', creditsDelta: -2 })],
    });

    const view = await books();

    expect(view.people.map((p) => [p.name, p.isYou, p.totals.sharedActivity])).toEqual([
      ['Me Myself', true, 2],
      ['Quinn Quiet', false, 0],
    ]);
  });

  it('leaves out a member who has not joined yet', async () => {
    setup({
      members: [member('user_me'), member('user_pending', null)],
      names: { user_me: 'Me', user_pending: 'Pat Pending' },
    });

    const view = await books();

    expect(view.people.map((p) => p.name)).toEqual(['Me']);
    expect(findAccountNames).toHaveBeenCalledWith(['user_me']);
  });

  it('sorts people by name, never by how much they moved', async () => {
    setup({
      members: [member('user_z'), member('user_a'), member('user_m')],
      names: { user_z: 'Zed', user_a: 'Amy', user_m: 'Mia' },
      rows: [
        row({ createdByUserId: 'user_z', creditsDelta: -500 }),
        row({ createdByUserId: 'user_a', creditsDelta: -1 }),
      ],
    });

    const view = await books();

    // Zed spent the most and Mia nothing; neither is where the order puts them.
    expect(view.people.map((p) => p.name)).toEqual(['Amy', 'Mia', 'Zed']);
  });

  it('breaks a tie between equal names by id so the order is stable', async () => {
    setup({
      members: [member('user_2'), member('user_1')],
      names: { user_2: 'Sam', user_1: 'Sam' },
    });

    const view = await books();

    expect(view.people.map((p) => p.userId)).toEqual(['user_1', 'user_2']);
  });

  it('calls a member with no account name "A member"', async () => {
    setup({
      members: [member('user_me'), member('user_n')],
      names: { user_me: 'Me', user_n: null },
    });

    const view = await books();

    expect(view.people.map((p) => p.name)).toEqual(['A member', 'Me']);
  });

  it('folds everybody who has left into one "Former members" line, last in the list', async () => {
    setup({
      members: [member('user_me'), member('user_z')],
      names: { user_me: 'Me', user_z: 'Zed' },
      rows: [
        row({ createdByUserId: 'user_gone1', creditsDelta: -3 }),
        row({ createdByUserId: 'user_gone2', creditsDelta: -4 }),
        row({
          kind: 'credit_back',
          creditsDelta: -6,
          memberUserId: 'user_gone1',
          booksCategory: 'creditedBack',
        }),
      ],
    });

    const view = await books();

    const last = view.people[view.people.length - 1];
    expect(view.people).toHaveLength(3);
    expect(last).toMatchObject({ userId: null, name: 'Former members', isYou: false });
    expect(last?.totals).toMatchObject({ sharedActivity: 7, creditedBack: 6 });
    // None of the former members' ids or names appear anywhere.
    expect(JSON.stringify(view)).not.toContain('user_gone');
  });

  it('shows no "Former members" line when nobody who left has any money in the window', async () => {
    setup({ members: [member('user_me')], names: { user_me: 'Me' } });

    const view = await books();

    expect(view.people.map((p) => p.name)).toEqual(['Me']);
  });

  it('counts money that is nobody’s in the group totals but on no person’s line', async () => {
    setup({
      members: [member('user_me')],
      names: { user_me: 'Me' },
      rows: [row({ creditsDelta: -2 })],
    });

    const view = await books();

    expect(view.totals.runningCosts).toBe(2);
    expect(view.people[0]?.totals.runningCosts).toBe(0);
    expect(view.people).toHaveLength(1);
  });

  it('sums each category across the window, in both the totals and the person’s line', async () => {
    setup({
      members: [member('user_a')],
      names: { user_a: 'Amy' },
      rows: [
        row({ createdByUserId: 'user_a', creditsDelta: -2 }),
        row({ createdByUserId: 'user_a', creditsDelta: -3 }),
        row({
          kind: 'transfer_in',
          creditsDelta: 10,
          createdByUserId: 'user_a',
          booksCategory: 'topUps',
        }),
        // The giver's half of the same top-up must not count again.
        row({
          kind: 'transfer_in',
          creditsDelta: -10,
          createdByUserId: 'user_a',
          booksCategory: 'none',
        }),
        row({
          kind: 'seat',
          creditsDelta: -4,
          memberUserId: 'user_a',
          createdByUserId: 'user_a',
          booksCategory: 'seats',
        }),
        // The pool's half of the same seat.
        row({ kind: 'seat', creditsDelta: 4, createdByUserId: 'user_a', booksCategory: 'none' }),
      ],
    });

    const view = await books();

    const expected = { sharedActivity: 5, topUps: 10, seats: 4 };
    expect(view.totals).toMatchObject(expected);
    expect(view.people[0]?.totals).toMatchObject(expected);
    // Every category is present on every figure set, so the UI never reads undefined.
    expect(Object.keys(view.totals).sort()).toEqual([...BOOKS_CATEGORIES].sort());
  });

  it('rounds each figure to two decimals after summing, not before', async () => {
    setup({
      members: [member('user_a')],
      names: { user_a: 'Amy' },
      rows: [
        row({ createdByUserId: 'user_a', creditsDelta: -0.123 }),
        row({ createdByUserId: 'user_a', creditsDelta: -0.123 }),
      ],
      pool: 10.456,
    });

    const view = await books();

    // 0.246 rounds to 0.25; rounding each 0.123 first would give 0.24.
    expect(view.totals.sharedActivity).toBe(0.25);
    expect(view.people[0]?.totals.sharedActivity).toBe(0.25);
    expect(view.poolBalanceCredits).toBe(10.46);
  });

  it('reports the shared balance, and zero when the group has no account yet', async () => {
    setup({ pool: 42 });
    expect((await books()).poolBalanceCredits).toBe(42);

    setup({ pool: null });
    expect((await books()).poolBalanceCredits).toBe(0);
  });

  describe('weeks', () => {
    it('defaults to twelve weeks, oldest first, ending with this week', async () => {
      setup();

      const view = await books();

      expect(DEFAULT_BOOKS_WEEKS).toBe(12);
      expect(view.weeks).toHaveLength(12);
      expect(view.weeks[11]?.weekStart).toBe(THIS_WEEK);
      expect(view.weeks[0]?.weekStart).toBe('2026-08-03T00:00:00.000Z');
      const starts = view.weeks.map((w) => new Date(w.weekStart).getTime());
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
    });

    it('reads the ledger from the start of the first week shown', async () => {
      setup();

      await books(3);

      const [scope, since] = listGroupLedgerSince.mock.calls[0] ?? [];
      expect(scope).toMatchObject({ spaceId: 'spc_group' });
      expect((since as Date).toISOString()).toBe('2026-10-05T00:00:00.000Z');
    });

    it.each([
      [0, 1],
      [-5, 1],
      [1, 1],
      [2.9, 2],
      [52, 52],
      [53, MAX_BOOKS_WEEKS],
      [1000, MAX_BOOKS_WEEKS],
    ])('clamps weeks=%s to %s', async (asked, expected) => {
      setup();

      const view = await books(asked);

      expect(view.weeks).toHaveLength(expected);
    });

    it('puts each row in its week and keeps person and group weekly figures aligned', async () => {
      setup({
        members: [member('user_a')],
        names: { user_a: 'Amy' },
        rows: [
          row({
            createdByUserId: 'user_a',
            creditsDelta: -1,
            createdAt: new Date('2026-10-06T10:00:00Z'),
          }),
          row({
            createdByUserId: 'user_a',
            creditsDelta: -2,
            createdAt: new Date('2026-10-19T00:00:00Z'),
          }),
          row({
            createdByUserId: 'user_a',
            creditsDelta: -4,
            createdAt: new Date('2026-10-18T23:59:59Z'),
          }),
        ],
      });

      const view = await books(3);

      // Weeks of 5, 12 and 19 October. Sunday 23:59 is last week; Monday 00:00 is this week.
      expect(view.weeks.map((w) => w.totals.sharedActivity)).toEqual([1, 4, 2]);
      expect(view.people[0]?.byWeek.map((f) => f.sharedActivity)).toEqual([1, 4, 2]);
      expect(view.people[0]?.byWeek).toHaveLength(view.weeks.length);
    });

    it('buckets on the group’s clock, so the same instant can fall in different weeks', async () => {
      // Sunday 12:00 UTC is already Monday 01:00 in Auckland (UTC+13 in October).
      const sundayNoonUtc = new Date('2026-10-18T12:00:00Z');
      const spend = row({ createdByUserId: 'user_a', creditsDelta: -9, createdAt: sundayNoonUtc });

      setup({
        members: [member('user_a')],
        names: { user_a: 'Amy' },
        rows: [spend],
        timezone: 'UTC',
      });
      const utc = await books(2);
      setup({
        members: [member('user_a')],
        names: { user_a: 'Amy' },
        rows: [spend],
        timezone: 'Pacific/Auckland',
      });
      const auckland = await books(2);

      expect(utc.weeks.map((w) => w.totals.sharedActivity)).toEqual([9, 0]);
      expect(auckland.weeks.map((w) => w.totals.sharedActivity)).toEqual([0, 9]);
      expect(auckland.timeZone).toBe('Pacific/Auckland');
    });

    it('falls back to UTC when the group has no clock', async () => {
      setup({ timezone: null });

      const view = await books();

      expect(view.timeZone).toBe('UTC');
      expect(view.weeks[11]?.weekStart).toBe(THIS_WEEK);
    });
  });
});
