import type { Metadata } from 'next';

import { AcceptInvite } from '@/components/resparkable/share/accept-invite';

/**
 * Where a share-invite email lands.
 *
 * **A doorway, not a destination.** It binds this account to the grant the token
 * names and redirects to the item; the only reason to stay on it is that
 * something went wrong.
 *
 * It is behind the session gate because `proxy.ts` protects `/resparkable` by
 * pathname prefix, and that is the whole authentication design of the accept
 * flow rather than an incidental placement: the token names a grant, and the
 * **session proves the address**. A signed-out invitee is sent to sign in and
 * returned here, which is exactly what should happen — there is nothing an
 * unauthenticated visitor could do on this page, because accepting means
 * connecting an account and they have not named one.
 *
 * `noindex`, and a title that names nothing. The URL carries a token and the
 * page is reached from an email; neither belongs in a search index or in a
 * browser history entry that says what somebody shared.
 */
export const metadata: Metadata = {
  title: 'Shared with you',
  description: 'Open something that has been shared with you.',
  robots: { index: false, follow: false, noarchive: true, nosnippet: true },
  referrer: 'no-referrer',
};

export default async function ResparkableInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // The token is not validated here. The service returns the same "not
  // available" for a malformed token as for an unknown, revoked, expired or
  // spent one, and rendering a different page for a bad shape would be the one
  // distinguishable answer in a flow whose failures are deliberately identical.
  return <AcceptInvite token={token} />;
}
