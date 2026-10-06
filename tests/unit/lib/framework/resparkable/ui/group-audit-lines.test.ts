/**
 * Unit Tests: the group admin record as sentences (phase 58, §23.13).
 *
 * The record is the one group surface where naming a person beside an action
 * is right, so these assert the wording, the "You" forms, the stand-in for a
 * nameless or erased account, and that an unknown action renders nothing
 * rather than a raw internal word.
 *
 * @see lib/framework/resparkable/ui/group-audit-lines.ts
 */

import { describe, expect, it } from 'vitest';

import { GROUP_AUDIT_ACTIONS } from '@/lib/framework/resparkable/repo/group-audit';
import { groupAuditLine } from '@/lib/framework/resparkable/ui/group-audit-lines';
import type { GroupAuditEntryWire } from '@/lib/framework/resparkable/ui/payloads';

function entry(overrides: Partial<GroupAuditEntryWire>): GroupAuditEntryWire {
  return {
    id: 'aud_1',
    action: 'role_changed',
    actorName: 'Sam',
    subjectName: 'Priya',
    aboutYou: false,
    byYou: false,
    metadata: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

/** A plausible metadata shape per action, so every action can render. */
const METADATA: Record<string, unknown> = {
  role_changed: { from: 'member', to: 'viewer' },
  member_removed: { role: 'member' },
  member_left: { role: 'member' },
  settings_changed: { fields: ['name'] },
  join_link_minted: { role: 'member', approval: 'open', maxUses: null },
  join_link_revoked: null,
  join_approved: { role: 'member' },
  join_rejected: null,
  invite_issued: { role: 'viewer' },
  invite_revoked: null,
  budget_changed: { fundingMode: 'self_funded' },
  member_cap_changed: { dailyCreditCap: 25 },
  topped_up: { credits: 40 },
};

describe('groupAuditLine', () => {
  it.each(GROUP_AUDIT_ACTIONS.map((action) => [action]))(
    'renders a plain sentence for %s, with no raw action word or address in it',
    (action) => {
      const line = groupAuditLine(entry({ action, metadata: METADATA[action] }));

      expect(line).not.toBeNull();
      expect(line).not.toContain('_');
      expect(line).not.toMatch(/@/);
    }
  );

  it('leads with the admin and names the person it was done to', () => {
    expect(groupAuditLine(entry({ metadata: { from: 'member', to: 'viewer' } }))).toBe(
      'Sam made Priya a viewer'
    );
  });

  it('says "you" when the reader is the one it was done to, and "You" when they did it', () => {
    expect(
      groupAuditLine(entry({ aboutYou: true, metadata: { from: 'member', to: 'admin' } }))
    ).toBe('Sam made you an admin');
    expect(groupAuditLine(entry({ byYou: true, action: 'member_removed' }))).toBe(
      'You removed Priya from the group'
    );
    expect(groupAuditLine(entry({ byYou: true, action: 'member_left' }))).toBe(
      'You left the group'
    );
  });

  it('describes a succession as automatic, with nobody named as having done it', () => {
    const line = groupAuditLine(
      entry({ actorName: null, metadata: { to: 'admin', reason: 'succession' } })
    );

    expect(line).toBe('Priya was made an admin automatically, because the group had no admin left');
  });

  it('stands in for a nameless or erased account rather than leaving a gap', () => {
    expect(
      groupAuditLine(entry({ actorName: null, subjectName: null, action: 'member_removed' }))
    ).toBe('Someone removed someone from the group');
  });

  it('renders a cap with its number, and a removed cap as removed', () => {
    expect(
      groupAuditLine(entry({ action: 'member_cap_changed', metadata: { dailyCreditCap: 25 } }))
    ).toBe('Sam set Priya’s daily limit to 25 credits');
    expect(
      groupAuditLine(entry({ action: 'member_cap_changed', metadata: { dailyCreditCap: null } }))
    ).toBe('Sam removed Priya’s daily limit');
  });

  it('falls back to a sentence without the detail when metadata is missing', () => {
    expect(groupAuditLine(entry({ action: 'join_link_minted', metadata: null }))).toBe(
      'Sam made a join link'
    );
    expect(groupAuditLine(entry({ action: 'invite_issued', metadata: null }))).toBe(
      'Sam invited someone to join'
    );
    expect(groupAuditLine(entry({ action: 'topped_up', metadata: null }))).toBe(
      'Sam added credits to the group'
    );
  });

  it('renders nothing for a role change to a role it does not know', () => {
    expect(groupAuditLine(entry({ metadata: { to: 'superuser' } }))).toBeNull();
  });

  it('renders nothing for an action it does not know', () => {
    expect(groupAuditLine(entry({ action: 'something_new' }))).toBeNull();
  });
});
