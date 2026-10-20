/**
 * A group's books: where its credits went, by person and by week (phase 62).
 *
 * Every member sees this, viewers included. It shows money and nothing else:
 * there is no count of anything anybody wrote, finished or sent anywhere in the
 * data it renders, and people are listed by name, never by amount, so the
 * table reads as an account and not as a ranking (§23.12's second amendment,
 * test 13n).
 *
 * No state and no fetching: the books arrive with the page, read once through
 * the one endpoint, and nothing here changes them.
 */

import * as React from 'react';

import { FieldHelp } from '@/components/ui/field-help';
import { formatDay } from '@/lib/framework/resparkable/ui/format-day';
import type {
  GroupBooksFiguresWire,
  GroupBooksWire,
} from '@/lib/framework/resparkable/ui/payloads';

/** The order and the words the books use for each kind of money. */
export const BOOKS_COLUMNS: ReadonlyArray<{ key: keyof GroupBooksFiguresWire; label: string }> = [
  { key: 'sharedActivity', label: 'Paid by the group' },
  { key: 'ownActivity', label: 'Paid from own balance' },
  { key: 'runningCosts', label: 'Running costs' },
  { key: 'seats', label: 'Places' },
  { key: 'topUps', label: 'Added' },
  { key: 'creditedBack', label: 'Given back' },
  { key: 'debtsTakenOn', label: 'Debts the group took on' },
];

export interface GroupBooksProps {
  books: GroupBooksWire;
}

export function GroupBooks({ books }: GroupBooksProps): React.ReactElement {
  // Only the kinds of money that moved in the window, so a group that never
  // charges for places is not shown an empty column for them.
  const columns = BOOKS_COLUMNS.filter((column) => books.totals[column.key] !== 0);
  const firstWeek = books.weeks[0];

  return (
    <section className="flex flex-col gap-3">
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        The group&apos;s books
        <FieldHelp title="The group's books">
          <p>
            Where the group&apos;s credits went, in credits, by person and by week. Everyone in the
            group can see this.
          </p>
          <p>
            It shows money only, and people are listed by name. Anyone who has left the group is
            counted together as former members.
          </p>
        </FieldHelp>
      </h3>
      <p className="text-muted-foreground text-xs">
        {firstWeek ? `Since ${formatDay(firstWeek.weekStart, books.timeZone)}. ` : ''}
        The shared balance is {books.poolBalanceCredits} credits.
      </p>

      {columns.length === 0 ? (
        <p className="text-muted-foreground text-xs">No credits have moved in this time.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground text-left">
                <tr>
                  <th className="py-1 pr-3 font-normal">Person</th>
                  {columns.map((column) => (
                    <th key={column.key} className="py-1 pr-3 font-normal">
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {books.people.map((person) => (
                  <tr key={person.userId ?? 'former'} className="border-border/60 border-t">
                    <td className="max-w-40 truncate py-1.5 pr-3">
                      {person.isYou ? 'You' : person.name}
                    </td>
                    {columns.map((column) => (
                      <td key={column.key} className="py-1.5 pr-3">
                        {person.totals[column.key]}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-border border-t font-medium">
                  <td className="py-1.5 pr-3">The whole group</td>
                  {columns.map((column) => (
                    <td key={column.key} className="py-1.5 pr-3">
                      {books.totals[column.key]}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          <details className="text-xs">
            <summary className="text-muted-foreground cursor-pointer">By week</summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full">
                <thead className="text-muted-foreground text-left">
                  <tr>
                    <th className="py-1 pr-3 font-normal">Week of</th>
                    {columns.map((column) => (
                      <th key={column.key} className="py-1 pr-3 font-normal">
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {books.weeks.map((week) => (
                    <tr key={week.weekStart} className="border-border/60 border-t">
                      <td className="py-1.5 pr-3">{formatDay(week.weekStart, books.timeZone)}</td>
                      {columns.map((column) => (
                        <td key={column.key} className="py-1.5 pr-3">
                          {week.totals[column.key]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
