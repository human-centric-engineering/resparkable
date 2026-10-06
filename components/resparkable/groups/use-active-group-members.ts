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

export interface ActiveGroup {
  /** Joined members only: a request to join is not a member yet. */
  members: ActiveGroupMember[];
  /** The reader's own role in the group. */
  yourRole: string;
}

/** The open group's members and the reader's role, or `null` outside a group. */
export function useActiveGroup(): ActiveGroup | null {
  const spaceId = useActiveSpaceId();
  const [spaces] = useTabFetch(spaceId ? RESPARKABLE_API.SPACES : null, openableSpacesSchema);
  const space =
    spaceId && spaces.status === 'ready'
      ? (spaces.data.find((candidate) => candidate.spaceId === spaceId) ?? null)
      : null;
  const groupId = space?.groupId ?? null;
  const [members] = useTabFetch(
    groupId ? RESPARKABLE_API.groupMembers(groupId) : null,
    groupMembersSchema
  );

  if (!spaceId || !space || members.status !== 'ready') return null;
  return {
    members: members.data.filter((member) => member.joinedAt !== null),
    yourRole: space.role,
  };
}

export function useActiveGroupMembers(): ActiveGroupMember[] | null {
  return useActiveGroup()?.members ?? null;
}

/** Whether a member can be given a task: a viewer cannot change one. */
export function canBeAssigned(member: ActiveGroupMember): boolean {
  return member.role === 'admin' || member.role === 'member';
}

/** "Sam", or a stand-in for an account with no name set. Never an address. */
export function memberName(member: ActiveGroupMember | undefined): string {
  return member?.name ?? 'A member with no name set';
}
