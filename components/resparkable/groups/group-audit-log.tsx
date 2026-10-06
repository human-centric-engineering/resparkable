'use client';

/**
 * The group's admin record on the group page (§23.13, phase 58).
 *
 * An admin sees every administrative action taken in the group; anybody else
 * sees the ones that were taken about them. One request on open, never one per
 * row. The server decides which entries a reader gets; this only renders them.
 *
 * Lines lead with the person, which is right here and nowhere else in a group:
 * this records administering, not anybody's work, so nothing is counted.
 */

import * as React from 'react';

import { ClientDate } from '@/components/ui/client-date';
import { FieldHelp } from '@/components/ui/field-help';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { groupAuditLine } from '@/lib/framework/resparkable/ui/group-audit-lines';
import {
  groupAuditEntriesSchema,
  type GroupAuditEntryWire,
} from '@/lib/framework/resparkable/ui/payloads';

export interface GroupAuditLogProps {
  groupId: string;
  isAdmin: boolean;
}

export function GroupAuditLog({ groupId, isAdmin }: GroupAuditLogProps): React.ReactElement | null {
  const [entries, setEntries] = React.useState<GroupAuditEntryWire[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const data: unknown = await apiClient.get(RESPARKABLE_API.groupAudit(groupId));
        const parsed = groupAuditEntriesSchema.safeParse(data);
        if (!live) return;
        if (parsed.success) setEntries(parsed.data);
        else setFailed(true);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [groupId]);

  // A member with nothing done to them has nothing to read here, and an empty
  // heading over nothing reads as something being hidden.
  if (!isAdmin && entries !== null && entries.length === 0) return null;

  const lines = (entries ?? [])
    .map((entry) => ({ entry, line: groupAuditLine(entry) }))
    .filter((row): row is { entry: GroupAuditEntryWire; line: string } => row.line !== null);

  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-1.5 text-sm font-medium">
        {isAdmin ? 'Admin record' : 'Changes to your membership'}
        <FieldHelp title={isAdmin ? 'Admin record' : 'Changes to your membership'}>
          {isAdmin
            ? 'Every change an admin has made to this group: roles, removals, join links, invitations and budget. Members can see the entries about them.'
            : 'What the group’s admins have changed about your membership, such as your role. Admins see the full record.'}
        </FieldHelp>
      </h2>

      {failed ? (
        <p className="text-muted-foreground text-sm">The record could not be loaded.</p>
      ) : entries === null ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : lines.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing has been changed yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {lines.map(({ entry, line }) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
            >
              <span>{line}</span>
              <ClientDate
                date={entry.createdAt}
                showTime
                className="text-muted-foreground text-[11px]"
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
