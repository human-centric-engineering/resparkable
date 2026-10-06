/**
 * The group admin record, as sentences (§23.13, phase 58).
 *
 * Pure, so the wording is tested without rendering anything. Unlike the
 * activity feed, a line here leads with the person: this is the one surface
 * where naming somebody beside an administrative action is correct, because
 * it is a record of administering, not of anybody's work.
 *
 * An action this file does not know renders as `null` and is dropped, so a
 * kind added later never shows a raw internal word to a member.
 */

import type { GroupAuditEntryWire } from '@/lib/framework/resparkable/ui/payloads';

const ROLE_WORD: Record<string, string> = {
  admin: 'an admin',
  member: 'a member',
  viewer: 'a viewer',
};

function roleWord(value: unknown): string | null {
  return typeof value === 'string' ? (ROLE_WORD[value] ?? null) : null;
}

/** One value from an entry's metadata, read without asserting its shape. */
function field(metadata: unknown, key: string): unknown {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  return Object.entries(metadata).find(([name]) => name === key)?.[1];
}

/** "You", a name, or a stand-in for an account with no name or one since erased. */
function who(name: string | null, isYou: boolean, fallback: string): string {
  if (isYou) return 'You';
  return name ?? fallback;
}

export function groupAuditLine(entry: GroupAuditEntryWire): string | null {
  const actor = who(entry.actorName, entry.byYou, 'Someone');
  const subject = entry.aboutYou ? 'you' : (entry.subjectName ?? 'someone');
  const subjectPossessive = entry.aboutYou ? 'your' : `${entry.subjectName ?? 'someone'}’s`;

  switch (entry.action) {
    case 'role_changed': {
      const to = roleWord(field(entry.metadata, 'to'));
      if (!to) return null;
      if (field(entry.metadata, 'reason') === 'succession') {
        return `${entry.aboutYou ? 'You were' : `${entry.subjectName ?? 'Someone'} was`} made ${to} automatically, because the group had no admin left`;
      }
      return `${actor} made ${subject} ${to}`;
    }
    case 'member_removed':
      return `${actor} removed ${subject} from the group`;
    case 'member_left':
      return `${entry.byYou ? 'You' : (entry.subjectName ?? 'Someone')} left the group`;
    case 'settings_changed':
      return `${actor} changed the group’s settings`;
    case 'join_link_minted': {
      const role = roleWord(field(entry.metadata, 'role'));
      return role ? `${actor} made a join link for ${role}` : `${actor} made a join link`;
    }
    case 'join_link_revoked':
      return `${actor} turned off a join link`;
    case 'join_approved':
      return `${actor} let ${subject} into the group`;
    case 'join_rejected':
      return `${actor} turned down ${subjectPossessive} request to join`;
    case 'invite_issued': {
      const role = roleWord(field(entry.metadata, 'role'));
      return role
        ? `${actor} invited someone to join as ${role}`
        : `${actor} invited someone to join`;
    }
    case 'invite_revoked':
      return `${actor} withdrew an invitation`;
    case 'budget_changed':
      return `${actor} changed the group’s budget settings`;
    case 'member_cap_changed': {
      const cap = field(entry.metadata, 'dailyCreditCap');
      return typeof cap === 'number'
        ? `${actor} set ${subjectPossessive} daily limit to ${cap} credits`
        : `${actor} removed ${subjectPossessive} daily limit`;
    }
    case 'topped_up': {
      const credits = field(entry.metadata, 'credits');
      return typeof credits === 'number'
        ? `${actor} added ${credits} credits to the group`
        : `${actor} added credits to the group`;
    }
    default:
      return null;
  }
}
