// @vitest-environment happy-dom

/**
 * GroupBooks Component Tests (phase 62; §23.12's second amendment).
 *
 * The books are money and nothing else, and they are an account, not a league
 * table. This file is the rendering half of test 13n (the service half is the
 * structural one: it reads the ledger and no other table):
 *
 *   1. **No output figures.** However different two members' numbers are, the
 *      rendered books show no count of items written, tasks finished or
 *      messages sent, and every number on screen is a credit figure from the
 *      payload.
 *   2. **No ranking.** Rows keep the payload's name order whatever the amounts,
 *      and no superlative or rank word appears.
 *   3. **Only kinds of money that moved get a column**, and a group where
 *      nothing moved gets an honest empty state.
 *
 * @see components/resparkable/groups/group-books.tsx
 */

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { BOOKS_COLUMNS, GroupBooks } from '@/components/resparkable/groups/group-books';
import type { GroupBooksWire } from '@/lib/framework/resparkable/ui/payloads';
import { makeBooks, makeFigures } from '@/tests/helpers/resparkable-group-budget';

/** Amy moves a great deal, Mia almost nothing, Zed some; names sort A, M, Z. */
const UNEVEN: GroupBooksWire = makeBooks({
  timeZone: 'UTC',
  poolBalanceCredits: 321.5,
  weeks: [
    {
      weekStart: '2026-10-12T00:00:00.000Z',
      totals: makeFigures({ sharedActivity: 400, topUps: 100 }),
    },
    {
      weekStart: '2026-10-19T00:00:00.000Z',
      totals: makeFigures({ sharedActivity: 551.25, ownActivity: 3, topUps: 200 }),
    },
  ],
  totals: makeFigures({ sharedActivity: 951.25, ownActivity: 3, topUps: 300 }),
  people: [
    {
      userId: 'user_amy',
      name: 'Amy Adams',
      isYou: false,
      totals: makeFigures({ sharedActivity: 900, topUps: 0 }),
      byWeek: [],
    },
    {
      userId: 'user_mia',
      name: 'Mia Moss',
      isYou: false,
      totals: makeFigures({ sharedActivity: 1, ownActivity: 3, topUps: 300 }),
      byWeek: [],
    },
    {
      userId: 'user_zed',
      name: 'Zed Zane',
      isYou: false,
      totals: makeFigures({ sharedActivity: 50.25, topUps: 0 }),
      byWeek: [],
    },
    {
      userId: null,
      name: 'Former members',
      isYou: false,
      totals: makeFigures(),
      byWeek: [],
    },
  ],
});

function peopleTable(): HTMLElement {
  const [table] = screen.getAllByRole('table', { hidden: true });
  if (!table) throw new Error('no table');
  return table;
}

/** The first cell of each body row, minus the "whole group" footer row. */
function personRows(): string[] {
  const rows = within(peopleTable()).getAllByRole('row', { hidden: true });
  return rows
    .slice(1)
    .map((row) => row.querySelector('td')?.textContent ?? '')
    .filter((name) => name !== 'The whole group');
}

function headers(table: HTMLElement): string[] {
  return within(table)
    .getAllByRole('columnheader', { hidden: true })
    .map((h) => h.textContent ?? '');
}

describe('GroupBooks (test 13n, the rendering half)', () => {
  it('shows no count of anything anybody wrote, finished or sent', () => {
    const { container } = render(<GroupBooks books={UNEVEN} />);

    const text = container.textContent ?? '';
    expect(text).not.toMatch(
      /\b(items?|tasks?|messages?|notes?|wrote|written|writing|finished|completed|sent|captured|ideas?|words?)\b/i
    );
  });

  it('shows only credit figures from the payload, so no other number can be on screen', () => {
    const { container } = render(<GroupBooks books={UNEVEN} />);

    const allowed = new Set<string>();
    const collect = (figures: ReturnType<typeof makeFigures>) =>
      Object.values(figures).forEach((value) => allowed.add(String(value)));
    collect(UNEVEN.totals);
    UNEVEN.people.forEach((person) => collect(person.totals));
    UNEVEN.weeks.forEach((week) => collect(week.totals));

    const shown = Array.from(container.querySelectorAll('tbody td'))
      .map((cell) => cell.textContent ?? '')
      .filter((cell) => /^[\d.]+$/.test(cell));
    expect(shown.length).toBeGreaterThan(0);
    for (const value of shown) expect(allowed).toContain(value);
  });

  it('uses no ranking or superlative wording', () => {
    const { container } = render(<GroupBooks books={UNEVEN} />);

    const text = container.textContent ?? '';
    expect(text).not.toMatch(
      /\b(top|most|least|rank(ed|ing)?|highest|lowest|biggest|largest|smallest|leader(board)?|best|worst|winner|heaviest)\b/i
    );
    expect(text).not.toMatch(/#\s?\d/);
  });

  it('keeps rows in name order whatever each person moved', () => {
    render(<GroupBooks books={UNEVEN} />);

    // Amy moved the most and Mia the least; a sort by amount (either way)
    // would put Mia or Zed first or last. Order is the payload's, which is name order.
    expect(personRows()).toEqual(['Amy Adams', 'Mia Moss', 'Zed Zane', 'Former members']);
  });

  it('keeps the same order when the amounts are reversed', () => {
    const reversed: GroupBooksWire = {
      ...UNEVEN,
      people: UNEVEN.people.map((person, index) => ({
        ...person,
        totals: makeFigures({ sharedActivity: (index + 1) * 100 }),
      })),
    };
    render(<GroupBooks books={reversed} />);

    expect(personRows()).toEqual(['Amy Adams', 'Mia Moss', 'Zed Zane', 'Former members']);
  });

  it('has no sort controls to reorder the table by amount', () => {
    render(<GroupBooks books={UNEVEN} />);

    expect(screen.queryByRole('button', { name: /sort|order/i })).not.toBeInTheDocument();
    for (const header of screen.getAllByRole('columnheader', { hidden: true })) {
      expect(header).not.toHaveAttribute('aria-sort');
      expect(within(header).queryByRole('button')).not.toBeInTheDocument();
    }
  });
});

describe('GroupBooks columns and figures', () => {
  it('gives a column only to kinds of money that moved in the window', () => {
    render(<GroupBooks books={UNEVEN} />);

    expect(headers(peopleTable())).toEqual([
      'Person',
      'Paid by the group',
      'Paid from own balance',
      'Added',
    ]);
  });

  it('keeps a column that only the group’s own money filled, such as running costs', () => {
    const books = makeBooks({
      totals: makeFigures({ runningCosts: 4 }),
      people: [{ userId: 'user_a', name: 'Amy', isYou: false, totals: makeFigures(), byWeek: [] }],
    });
    render(<GroupBooks books={books} />);

    expect(headers(peopleTable())).toEqual(['Person', 'Running costs']);
  });

  it('can show every kind of money, in the documented order', () => {
    const everything = makeFigures({
      sharedActivity: 1,
      ownActivity: 2,
      runningCosts: 3,
      seats: 4,
      topUps: 5,
      creditedBack: 6,
      debtsTakenOn: 7,
    });
    render(<GroupBooks books={makeBooks({ totals: everything })} />);

    expect(headers(peopleTable())).toEqual(['Person', ...BOOKS_COLUMNS.map((c) => c.label)]);
    expect(BOOKS_COLUMNS.map((c) => c.key).sort()).toEqual(Object.keys(everything).sort());
  });

  it('reads each cell from the payload and ends with the whole group’s totals', () => {
    render(<GroupBooks books={UNEVEN} />);

    const rows = within(peopleTable()).getAllByRole('row', { hidden: true });
    const cells = (row: HTMLElement) =>
      within(row)
        .getAllByRole('cell', { hidden: true })
        .map((c) => c.textContent);
    expect(cells(rows[2])).toEqual(['Mia Moss', '1', '3', '300']);
    expect(cells(rows[rows.length - 1])).toEqual(['The whole group', '951.25', '3', '300']);
  });

  it('says "You" on the viewer’s own row, and never repeats their name', () => {
    const books = makeBooks({
      totals: makeFigures({ sharedActivity: 2 }),
      people: [
        {
          userId: 'user_me',
          name: 'Morgan Me',
          isYou: true,
          totals: makeFigures({ sharedActivity: 2 }),
          byWeek: [],
        },
      ],
    });
    render(<GroupBooks books={books} />);

    expect(personRows()).toEqual(['You']);
    expect(screen.queryByText('Morgan Me')).not.toBeInTheDocument();
  });

  it('states the shared balance and when the window starts, on the group’s calendar', () => {
    render(<GroupBooks books={UNEVEN} />);

    expect(screen.getByText(/Since 12 October\./)).toBeInTheDocument();
    expect(screen.getByText(/The shared balance is 321.5 credits\./)).toBeInTheDocument();
  });

  it('dates the window in the group’s time zone', () => {
    // Sunday 11:00 UTC is Monday in Auckland, where this week began.
    const books = makeBooks({
      timeZone: 'Pacific/Auckland',
      weeks: [{ weekStart: '2026-10-18T11:00:00.000Z', totals: makeFigures({ topUps: 1 }) }],
      totals: makeFigures({ topUps: 1 }),
    });
    render(<GroupBooks books={books} />);

    expect(screen.getByText(/Since 19 October\./)).toBeInTheDocument();
  });

  it('lists the weeks oldest first, each dated by its Monday, with that week’s totals', () => {
    render(<GroupBooks books={UNEVEN} />);

    const weekly = screen.getAllByRole('table', { hidden: true })[1];
    const rows = within(weekly).getAllByRole('row', { hidden: true }).slice(1);
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole('cell', { hidden: true })
          .map((c) => c.textContent)
      )
    ).toEqual([
      ['12 October', '400', '0', '100'],
      ['19 October', '551.25', '3', '200'],
    ]);
  });
});

describe('GroupBooks when nothing moved', () => {
  it('says so, shows no table, and still states the shared balance', () => {
    const books = makeBooks({
      poolBalanceCredits: 12,
      weeks: [{ weekStart: '2026-10-12T00:00:00.000Z', totals: makeFigures() }],
      people: [{ userId: 'user_a', name: 'Amy', isYou: false, totals: makeFigures(), byWeek: [] }],
    });
    render(<GroupBooks books={books} />);

    expect(screen.getByText('No credits have moved in this time.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByText(/The shared balance is 12 credits\./)).toBeInTheDocument();
  });

  it('copes with a window that has no weeks at all', () => {
    render(<GroupBooks books={makeBooks()} />);

    expect(screen.getByText('No credits have moved in this time.')).toBeInTheDocument();
    expect(screen.queryByText(/Since/)).not.toBeInTheDocument();
  });
});
