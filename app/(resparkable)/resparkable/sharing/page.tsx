import type { Metadata } from 'next';

import { MySharesView } from '@/components/resparkable/share/my-shares-view';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { mySharesSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Shared by me',
  description: 'Everything you have shared, and how to stop sharing it.',
};

/**
 * The other direction from `/resparkable/shared`.
 *
 * That page shows what other people have given you. This one shows what you
 * have given away, and exists for one reason: `ShareDialog` is only reachable
 * through an item's own control, so a share on an item you can no longer open
 * could not be closed at all. A link minted on a morning briefing outlived the
 * card that minted it by exactly one night.
 *
 * Ordering comes from the server and is kept, not re-sorted: gone, then
 * archived, then live. Somebody on this page is nearly always here to close
 * something, and the shares with no other route to them belong at the top.
 */
export default async function ResparkableSharingPage() {
  const shares = await readResparkable(RESPARKABLE_API.SHARES, mySharesSchema);

  if (!shares.ok) {
    return <LoadError what="what you have shared" message={shares.message} />;
  }

  return <MySharesView items={shares.data} />;
}
