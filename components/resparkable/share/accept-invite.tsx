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
 * ## The states, and why most of them say almost nothing
 *
 * **Accepted** redirects straight to the item. The invite page is a doorway, not
 * a destination.
 *
 * **Unverified** is the right address on an account that has not confirmed it.
 * Nothing is bound until it has (`privacy/address.ts`), and the reader is very
 * likely the real owner, so the page says what to do: confirm the address from
 * the account page, where Sunrise's email status card sends the link.
 *
 * **Wrong account** is the other state that explains itself, and it explains
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
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Handshake } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { acceptInviteResponseSchema } from '@/lib/framework/resparkable/ui/payloads';
import { CONFIRM_ADDRESS_ROUTE, RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

type State =
  | { kind: 'working' }
  | { kind: 'wrong_account'; expectedEmail: string }
  | { kind: 'unverified' }
  | { kind: 'unavailable' };

export function AcceptInvite({ token }: { token: string }): React.ReactElement {
  const router = useRouter();
  const [state, setState] = React.useState<State>({ kind: 'working' });
  /**
   * Accepting is single-use, so the effect must fire once per token — and in
   * development it would otherwise fire twice.
   *
   * `reactStrictMode` is on (`next.config.js`), so React deliberately mounts,
   * unmounts and remounts every effect in dev. `acceptGrant` clears
   * `inviteTokenHash` on the first call, so the second POST finds no grant and
   * renders "This is not available" — over the top of a token that was in fact
   * accepted a millisecond earlier. The `cancelled` flag alone does not help:
   * it suppresses the first run's `router.replace` and lets the second run's
   * failure win.
   *
   * A ref rather than state, because it must be read synchronously on the
   * remount and must not itself trigger a render.
   */
  const started = React.useRef(false);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;

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
          setState(
            parsed.data.reason === 'unverified'
              ? { kind: 'unverified' }
              : { kind: 'wrong_account', expectedEmail: parsed.data.expectedEmail ?? '' }
          );
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

  if (state.kind === 'unverified') {
    return (
      <EmptyState
        icon={Handshake}
        title="Confirm your email address first"
        description="This was shared with your address, but your account has not confirmed it yet. Confirm it, then open this link again."
        action={
          <Button asChild>
            <Link href={CONFIRM_ADDRESS_ROUTE}>Confirm my address</Link>
          </Button>
        }
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
