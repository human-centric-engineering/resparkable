'use client';

/**
 * AcceptInvite — the page an invite email lands on.
 *
 * ## Why it accepts on mount rather than behind a button
 *
 * There is nothing to consent to. The grant is **already live** for the address
 * it was issued to; accepting binds this account to it so it survives an address
 * change and so the owner can tell an opened share from an unopened one.
 * Presenting that as a decision would ask the reader to weigh something that has
 * already happened, and a button labelled "Accept" would imply that not pressing
 * it means not having access, which is untrue.
 *
 * ## The three states, and why two of them say almost nothing
 *
 * **Accepted** redirects straight to the item. The invite page is a doorway, not
 * a destination.
 *
 * **Wrong account** is the only state that explains itself, and it explains
 * itself with a *masked* address: enough to recognise which of your own mailboxes
 * to sign in with, not enough for a stranger holding a forwarded email to learn
 * a working address. §13 asks for both halves of that.
 *
 * **Not available** covers a bad token, an unknown one, a revoked grant, an
 * expired one and one already spent — deliberately indistinguishable, because
 * anything else turns this page into an oracle about which invitations once
 * existed. It also does not say "ask them to send it again": most of the time
 * this appears because somebody withdrew access, and prompting a conversation
 * the owner did not choose to have is not this page's business.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Handshake } from 'lucide-react';

import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { acceptInviteResponseSchema } from '@/lib/framework/resparkable/ui/payloads';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

type State =
  { kind: 'working' } | { kind: 'wrong_account'; expectedEmail: string } | { kind: 'unavailable' };

export function AcceptInvite({ token }: { token: string }): React.ReactElement {
  const router = useRouter();
  const [state, setState] = React.useState<State>({ kind: 'working' });

  React.useEffect(() => {
    let cancelled = false;

    async function accept(): Promise<void> {
      try {
        const response = await fetch(RESPARKABLE_API.ACCEPT_INVITE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const payload: unknown = await response.json();
        if (cancelled) return;

        if (!response.ok || !isSuccess(payload)) {
          setState({ kind: 'unavailable' });
          return;
        }

        // Parsed, never cast: this is a network response, and a shape change
        // upstream should surface here rather than as an undefined field in a
        // redirect target.
        const parsed = acceptInviteResponseSchema.safeParse(payload.data);
        if (!parsed.success) {
          setState({ kind: 'unavailable' });
          return;
        }

        if (!parsed.data.accepted) {
          setState({
            kind: 'wrong_account',
            expectedEmail: parsed.data.expectedEmail ?? '',
          });
          return;
        }

        // `replace`, not `push`: the invite URL should not sit in the back
        // stack. Returning to it re-runs an accept that has already happened,
        // and its token is spent, so the reader would land on "not available"
        // by pressing Back.
        router.replace(
          RESPARKABLE_ROUTES.sharedItem(parsed.data.entityType ?? '', parsed.data.entityId ?? '')
        );
      } catch {
        if (!cancelled) setState({ kind: 'unavailable' });
      }
    }

    void accept();
    return () => {
      cancelled = true;
    };
  }, [token, router]);

  if (state.kind === 'working') {
    return <SkeletonList label="Opening what was shared with you" />;
  }

  if (state.kind === 'wrong_account') {
    return (
      <EmptyState
        icon={Handshake}
        title="This was shared with a different account"
        description={`It was shared with ${state.expectedEmail}. Sign in with that account to open it.`}
      />
    );
  }

  return (
    <EmptyState
      icon={Handshake}
      title="This is not available"
      description="The link may be out of date, or what it pointed at is no longer shared."
    />
  );
}

function isSuccess(payload: unknown): payload is { success: true; data: unknown } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'success' in payload &&
    payload.success === true &&
    'data' in payload
  );
}
