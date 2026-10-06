'use client';

/**
 * The comment thread on an item in a group workspace (§23.13, phase 58).
 *
 * Every member can comment on every item in their group, because they can
 * already write the item itself. In a personal workspace there is nobody else
 * to talk to, so this renders nothing, and the shared-item page keeps its own
 * thread for things shared with you.
 *
 * Whether the composer shows is the server's answer (`canComment` on the
 * thread's own read), so a group viewer sees the conversation and no box to
 * add to it, without this component knowing anybody's role.
 */

import * as React from 'react';

import { CommentThread } from '@/components/resparkable/share/comment-thread';
import { useActiveSpaceId } from '@/lib/framework/resparkable/ui/use-active-space';
import type { ResparkableShareableType } from '@/lib/framework/resparkable/validations';

export interface GroupCommentThreadProps {
  /** One of the shareable types; a thought or a person has no thread. */
  entityType: ResparkableShareableType;
  entityId: string;
}

export function GroupCommentThread({
  entityType,
  entityId,
}: GroupCommentThreadProps): React.ReactElement | null {
  const spaceId = useActiveSpaceId();
  if (spaceId === null) return null;
  return <CommentThread entityType={entityType} entityId={entityId} />;
}
