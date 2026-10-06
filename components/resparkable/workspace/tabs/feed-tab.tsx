'use client';

/**
 * The `feed` tab: a group workspace's activity feed (§23.10, phase 59). Its own
 * tab rather than part of the Activity pane, which is a decision queue: a
 * record and a queue on one surface is a surface where the queue wins.
 */

import * as React from 'react';

import { GroupFeed } from '@/components/resparkable/groups/group-feed';

export function FeedTab(): React.ReactElement {
  return <GroupFeed />;
}
