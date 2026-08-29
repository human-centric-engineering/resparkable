import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { SharedItemDetail } from '@/components/resparkable/share/shared-item-detail';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { sharedItemDetailSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

/**
 * One item somebody shared with you.
 *
 * **The title is generic and stays generic.** Naming the item in `<title>`
 * would put another person's project name in this reader's browser history, in
 * their tab strip during a screen share, and in any telemetry that records page
 * titles. The public reader page makes the same choice for the same reason, and
 * the fact that this one is behind a session does not change whose material it
 * is.
 */
export const metadata: Metadata = {
  title: 'Shared with me',
  description: 'An item someone has shared with you.',
};

export default async function ResparkableSharedItemPage({
  params,
}: {
  params: Promise<{ entityType: string; entityId: string }>;
}) {
  const { entityType, entityId } = await params;

  const detail = await readResparkable(
    RESPARKABLE_API.sharedItem(entityType, entityId),
    sharedItemDetailSchema
  );

  // Every failure is the same failure. No grant, a revoked grant, an expired
  // one, a deleted item, an unshareable type and a load error all render the
  // same not-found page — anything distinguishable tells a guesser which of
  // those it was.
  if (!detail.ok) {
    notFound();
  }

  return <SharedItemDetail detail={detail.data} />;
}
