import type { Metadata } from 'next';

import { AcceptGroupInvite } from '@/components/resparkable/groups/accept-group-invite';

/**
 * Where a group-invitation email lands.
 *
 * Behind the session gate, because `proxy.ts` protects `/resparkable` by
 * pathname prefix, and that placement IS the authentication design rather than
 * an incidental one: the token names the invitation and the **session proves the
 * address**. A signed-out invitee is sent to sign in and returned here, which is
 * exactly right, because accepting means connecting an account and they have not
 * named one.
 *
 * Unlike the share-invite page, this is a destination rather than a doorway: it
 * asks before it acts, because joining a group is a real decision and clicking a
 * link in an email is not one. See the component for that argument in full.
 *
 * `noindex`, and a title that names nothing. The URL carries a token and the
 * page is reached from an email; neither belongs in a search index or in a
 * browser history entry naming somebody's group.
 */
export const metadata: Metadata = {
  title: 'Group invitation',
  description: 'Join a group you have been invited to.',
  robots: { index: false, follow: false, noarchive: true, nosnippet: true },
  referrer: 'no-referrer',
};

export default async function ResparkableGroupInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Not validated here. The service answers the same "not available" for a
  // malformed token as for an unknown, withdrawn, expired or spent one, and a
  // different page for a bad shape would be the one distinguishable answer in a
  // flow whose failures are deliberately identical.
  return <AcceptGroupInvite token={token} />;
}
