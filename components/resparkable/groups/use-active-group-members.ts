'use client';

/**
 * The joined members of the group whose workspace is open, or `null` in a
 * personal workspace (phase 58). For the assignee picker and the names on
 * board cards: one request for the workspace list and one for its members,
 * per surface, never one per row.
 */

import { z } from 'zod';

import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import {
  groupMemberSchema,
  openableSpacesSchema,
  type GroupDetailWire,
} from '@/lib/framework/resparkable/ui/payloads';
import { useActiveSpaceId } from '@/lib/framework/resparkable/ui/use-active-space';

const groupMembersSchema = z.array(groupMemberSchema);

export type ActiveGroupMember = GroupDetailWire['members'][number];

export function useActiveGroupMembers(): ActiveGroupMember[] | null {
  const spaceId = useActiveSpaceId();
  const [spaces] = useTabFetch(spaceId ? RESPARKABLE_API.SPACES : null, openableSpacesSchema);
  const groupId =
    spaceId && spaces.status === 'ready'
      ? (spaces.data.find((space) => space.spaceId === spaceId)?.groupId ?? null)
      : null;
  const [members] = useTabFetch(
    groupId ? RESPARKABLE_API.groupMembers(groupId) : null,
    groupMembersSchema
  );

  if (!spaceId || members.status !== 'ready') return null;
  // A request to join is not a member, so nobody can be assigned to one.
  return members.data.filter((member) => member.joinedAt !== null);
}

/** "Sam", or a stand-in for an account with no name set. Never an address. */
export function memberName(member: ActiveGroupMember | undefined): string {
  return member?.name ?? 'A member with no name set';
}
