/**
 * A group's books (§23.12's second amendment, phase 62, decision 8).
 *
 * ## The books show money, never output
 *
 * Every member, viewers included, can read where the group's credits went: by
 * person, by category and by week. That reverses phase 50's "members see
 * nothing about who spent it", and the line 23.8 draws moves rather than
 * disappears. An account of who spent what is a fair question in a group paying
 * a shared bill; a table of who produced what is the surveillance 23.8 refuses.
 * So this reads the ledger and nothing else (`repo/group-books.ts`), it has no
 * figure for items written, tasks finished or messages sent, and **people are
 * listed by name, never by amount**, so the books do not turn into a league
 * table of spenders either. Test 13n asserts it.
 *
 * ## Names, never addresses
 *
 * A current member is named from their account name, the same source the
 * members routes use. Everybody who has left or been erased is folded into one
 * "Former members" line: their money is part of the group's history, and their
 * name is no longer the group's to show.
 */

import {
  listGroupLedgerSince,
  type BooksLedgerRow,
} from '@/lib/framework/resparkable/repo/group-books';
import { findCreditAccount } from '@/lib/framework/resparkable/repo/billing';
import { findAccountNames, listGroupMembers } from '@/lib/framework/resparkable/repo/groups';
import { findGroupWithClockBySpaceId } from '@/lib/framework/resparkable/repo/group-billing';
import { resolveGroupMembership } from '@/lib/framework/resparkable/services/membership';
import { addZonedDays, startOfZonedWeek } from '@/lib/framework/resparkable/time/zoned';

export const BOOKS_CATEGORIES = [
  /** Seats, paid from members' own balances into the pool. */
  'seats',
  /** Runs nobody started, such as the weekly summary. */
  'runningCosts',
  /** Runs a member started that the pool paid for. */
  'sharedActivity',
  /** Runs paid from members' own balances (their own, or a share of a split). */
  'ownActivity',
  /** Credits added to the group, by hand or automatically. */
  'topUps',
  /** Credits given back to people: on leaving, or when a group closes. */
  'creditedBack',
  /** Debts the pool took over from people who left. */
  'debtsTakenOn',
] as const;

export type BooksCategory = (typeof BOOKS_CATEGORIES)[number];
export type BooksFigures = Record<BooksCategory, number>;

export const DEFAULT_BOOKS_WEEKS = 12;
export const MAX_BOOKS_WEEKS = 52;

/** A line in the books: one current member, or every former member together. */
export interface BooksPerson {
  /** `null` for the "Former members" line. */
  userId: string | null;
  name: string;
  isYou: boolean;
  totals: BooksFigures;
  /** One entry per week, in the same order as {@link GroupBooksView.weeks}. */
  byWeek: BooksFigures[];
}

export interface GroupBooksView {
  timeZone: string;
  poolBalanceCredits: number;
  weeks: Array<{ weekStart: string; totals: BooksFigures }>;
  /** The whole group, including money that is nobody's (the pool's running costs). */
  totals: BooksFigures;
  people: BooksPerson[];
}

export type GroupBooksResult =
  { ok: true; value: GroupBooksView } | { ok: false; reason: 'not_a_member' };

function zero(): BooksFigures {
  return {
    seats: 0,
    runningCosts: 0,
    sharedActivity: 0,
    ownActivity: 0,
    topUps: 0,
    creditedBack: 0,
    debtsTakenOn: 0,
  };
}

function round(credits: number): number {
  return Math.round(credits * 100) / 100;
}

function rounded(figures: BooksFigures): BooksFigures {
  const out = zero();
  for (const category of BOOKS_CATEGORIES) out[category] = round(figures[category]);
  return out;
}

/**
 * What one ledger row means in the books: a category, the person it is about
 * (`null` when it is nobody's), and a positive amount. `null` for the half of a
 * two-sided move that would count the same credits twice, and for kinds the
 * books do not show.
 *
 * Every money move between two accounts in a group writes a row on each side
 * (`repo/group-billing*.ts`), so each kind is read from exactly one side.
 */
export function classifyLedgerRow(
  row: BooksLedgerRow
): { category: BooksCategory; userId: string | null; credits: number } | null {
  const amount = Math.abs(row.creditsDelta);
  if (amount === 0) return null;
  switch (row.kind) {
    case 'seat':
      // The member's side; the pool's side is the same credits arriving.
      return row.memberUserId
        ? { category: 'seats', userId: row.memberUserId, credits: amount }
        : null;
    case 'agent_spend':
      if (row.createdByUserId === null) {
        // Nobody started it. Paid by the pool, or by the admin who pays.
        return { category: 'runningCosts', userId: row.memberUserId, credits: amount };
      }
      return row.memberUserId
        ? { category: 'ownActivity', userId: row.memberUserId, credits: amount }
        : { category: 'sharedActivity', userId: row.createdByUserId, credits: amount };
    case 'transfer_in':
    case 'auto_top_up':
      return row.creditsDelta > 0
        ? { category: 'topUps', userId: row.createdByUserId, credits: amount }
        : null;
    case 'admin_grant':
      // Credits an operator gave the group: nobody in it added them.
      return { category: 'topUps', userId: null, credits: amount };
    case 'credit_back':
      return { category: 'creditedBack', userId: row.memberUserId, credits: amount };
    case 'debt_absorbed':
      // The pool's side, attributed to whose debt it was.
      return row.memberUserId
        ? null
        : { category: 'debtsTakenOn', userId: row.createdByUserId, credits: amount };
    default:
      return null;
  }
}

/**
 * The group's books over the last `weeks` weeks, Monday to Sunday on the
 * group's clock. Any joined member, viewers included.
 */
export async function getGroupBooks(
  actorUserId: string,
  groupId: string,
  weeks: number = DEFAULT_BOOKS_WEEKS,
  now: Date = new Date()
): Promise<GroupBooksResult> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };
  const { scope, membership } = resolved;

  const span = Math.min(Math.max(1, Math.floor(weeks)), MAX_BOOKS_WEEKS);
  const clock = await findGroupWithClockBySpaceId(scope.spaceId);
  const timeZone = clock?.timezone ?? 'UTC';
  const thisWeek = startOfZonedWeek(now, timeZone);
  const starts: Date[] = [];
  for (let back = span - 1; back >= 0; back--) {
    starts.push(addZonedDays(thisWeek, -7 * back, timeZone));
  }
  const since = starts[0] ?? thisWeek;

  const [rows, members, pool] = await Promise.all([
    listGroupLedgerSince(scope, since),
    listGroupMembers(membership.group.id),
    findCreditAccount(scope),
  ]);
  const current = members.filter((member) => member.joinedAt !== null);
  const names = await findAccountNames(current.map((member) => member.userId));
  const currentIds = new Set(current.map((member) => member.userId));

  const weekIndex = (at: Date): number => {
    for (let index = starts.length - 1; index >= 0; index--) {
      const start = starts[index];
      if (start && at >= start) return index;
    }
    return 0;
  };

  const FORMER = '\u0000former';
  const people = new Map<string, { totals: BooksFigures; byWeek: BooksFigures[] }>();
  const line = (key: string) => {
    let entry = people.get(key);
    if (!entry) {
      entry = { totals: zero(), byWeek: starts.map(() => zero()) };
      people.set(key, entry);
    }
    return entry;
  };
  for (const member of current) line(member.userId);

  const weekTotals = starts.map(() => zero());
  const totals = zero();
  for (const row of rows) {
    const meaning = classifyLedgerRow(row);
    if (!meaning) continue;
    const index = weekIndex(row.createdAt);
    totals[meaning.category] += meaning.credits;
    const week = weekTotals[index];
    if (week) week[meaning.category] += meaning.credits;
    if (meaning.userId === null) continue;
    const entry = line(currentIds.has(meaning.userId) ? meaning.userId : FORMER);
    entry.totals[meaning.category] += meaning.credits;
    const personWeek = entry.byWeek[index];
    if (personWeek) personWeek[meaning.category] += meaning.credits;
  }

  const listed: BooksPerson[] = current
    .map((member) => {
      const entry = line(member.userId);
      return {
        userId: member.userId,
        name: names.get(member.userId) ?? 'A member',
        isYou: member.userId === actorUserId,
        totals: rounded(entry.totals),
        byWeek: entry.byWeek.map(rounded),
      };
    })
    // By name, never by amount.
    .sort((a, b) => a.name.localeCompare(b.name) || (a.userId ?? '').localeCompare(b.userId ?? ''));
  const former = people.get(FORMER);
  if (former) {
    listed.push({
      userId: null,
      name: 'Former members',
      isYou: false,
      totals: rounded(former.totals),
      byWeek: former.byWeek.map(rounded),
    });
  }

  return {
    ok: true,
    value: {
      timeZone,
      poolBalanceCredits: round(pool?.balanceCredits ?? 0),
      weeks: starts.map((start, index) => ({
        weekStart: start.toISOString(),
        totals: rounded(weekTotals[index] ?? zero()),
      })),
      totals: rounded(totals),
      people: listed,
    },
  };
}
