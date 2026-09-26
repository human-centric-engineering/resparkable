import type { Metadata } from 'next';

import { JoinGroup } from '@/components/resparkable/groups/join-group';

/**
 * Where a group join link lands (§23.11, phase 57).
 *
 * Behind the session gate, because `proxy.ts` protects `/resparkable` by
 * pathname prefix: joining attaches an account to a group, and a signed-out
 * visitor is sent to sign in and returned here.
 *
 * The page reads nothing and redeems nothing on its own. The component asks
 * first and then POSTs, so the redemption goes through the API route and its
 * daily rate limit, and there is no server-side path that would skip it.
 *
 * `noindex`, no referrer, and a title that names nothing: the URL is the
 * credential, and nothing about it belongs in a search index, a history entry,
 * or another site's logs.
 */
export const metadata: Metadata = {
  title: 'Join a group',
  description: 'Join a group from a link somebody shared with you.',
  robots: { index: false, follow: false, noarchive: true, nosnippet: true },
  referrer: 'no-referrer',
};

export default async function ResparkableGroupJoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Not validated here, for the invite page's reason: every bad token gets the
  // same "not available" answer, and a different page for a bad shape would be
  // the one distinguishable one.
  return <JoinGroup token={token} />;
}
