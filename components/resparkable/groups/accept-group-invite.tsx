'use client';

/**
 * AcceptGroupInvite: the page a group-invitation email lands on.
 *
 * ## Why this one has a button and the share invite does not
 *
 * `AcceptInvite` accepts on mount, and its header explains why: the grant is
 * **already live** for the address it was issued to, so there is nothing to
 * consent to and a button labelled "Accept" would imply that not pressing it
 * means not having access, which is untrue.
 *
 * Here the opposite is true on every point. The invitation grants nothing until
 * it is accepted, accepting creates read and write access to an entire shared
 * workspace, and a group workspace has no private tier: anything the reader adds
 * there is visible to every other member (§23.4). That is a real decision, and
 * one made by clicking a link in an email if this page accepts on mount. So it
 * says what joining means and waits.
 *
 * ## The three failure states, and why two say almost nothing
 *
 * **Wrong account** is the only one that explains itself, with a *masked*
 * address: enough to recognise which of your own mailboxes to sign in with, and
 * not enough for a stranger holding a forwarded email to learn a working one.
 *
 * **Not available** covers a bad token, an unknown one, a withdrawn invitation,
 * an expired one and one already spent, deliberately indistinguishable. Here
 * that matters twice over: anything else would be an oracle about which
 * invitations once existed AND about which groups do.
 *
 * **Joined** does not redirect, unlike the share flow. Phase 46 ships no group
 * surface to redirect to; phase 47's switcher is what makes a space reachable.
 * Saying so plainly beats sending somebody to a page that does not exist yet.
 */

import * as React from 'react';
import { Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { acceptGroupInviteResponseSchema } from '@/lib/framework/resparkable/ui/payloads';

type State =
  | { kind: 'offered' }
  | { kind: 'joining' }
  | { kind: 'joined'; groupName: string; alreadyMember: boolean }
  | { kind: 'wrong_account'; expectedEmail: string }
  | { kind: 'unavailable' };

export function AcceptGroupInvite({ token }: { token: string }): React.ReactElement {
  const [state, setState] = React.useState<State>({ kind: 'offered' });

  async function join(): Promise<void> {
    setState({ kind: 'joining' });
    try {
      const response = await fetch(RESPARKABLE_API.ACCEPT_GROUP_INVITE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const payload: unknown = await response.json();

      if (!response.ok || !isSuccess(payload)) {
        setState({ kind: 'unavailable' });
        return;
      }

      // Parsed, never cast: this is a network response, and a shape change
      // upstream should surface here rather than as an undefined field on a
      // screen that says somebody joined something.
      const parsed = acceptGroupInviteResponseSchema.safeParse(payload.data);
      if (!parsed.success) {
        setState({ kind: 'unavailable' });
        return;
      }

      if (!parsed.data.joined) {
        setState(
          parsed.data.reason === 'wrong_account'
            ? { kind: 'wrong_account', expectedEmail: parsed.data.expectedEmail ?? '' }
            : { kind: 'unavailable' }
        );
        return;
      }

      setState({
        kind: 'joined',
        groupName: parsed.data.groupName ?? 'the group',
        alreadyMember: parsed.data.alreadyMember ?? false,
      });
    } catch {
      setState({ kind: 'unavailable' });
    }
  }

  if (state.kind === 'joined') {
    return (
      <EmptyState
        icon={Users}
        title={
          state.alreadyMember
            ? 'You are already in this group'
            : `You have joined ${state.groupName}`
        }
        description="Your own workspace stays private and separate."
      />
    );
  }

  if (state.kind === 'wrong_account') {
    return (
      <EmptyState
        icon={Users}
        title="This invitation was sent to a different account"
        description={`It was sent to ${state.expectedEmail}. Sign in with that account to join.`}
      />
    );
  }

  if (state.kind === 'unavailable') {
    return (
      <EmptyState
        icon={Users}
        title="This invitation is not available"
        description="The link may be out of date, or it may have been withdrawn."
      />
    );
  }

  return (
    <EmptyState
      icon={Users}
      title="You have been invited to a group"
      description="A group workspace is shared with everyone in it. Anything you add there can be seen by every other member, and anything they add is visible to you. Your own workspace stays private and separate."
      action={
        <Button onClick={() => void join()} disabled={state.kind === 'joining'}>
          {state.kind === 'joining' ? 'Joining…' : 'Join the group'}
        </Button>
      }
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
