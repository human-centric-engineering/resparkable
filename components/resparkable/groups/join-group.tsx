'use client';

/**
 * JoinGroup: the page a group join link lands on (§23.11, phase 57).
 *
 * ## It asks before it acts
 *
 * The same reasoning as `AcceptGroupInvite`: joining a group is a real
 * decision, a group workspace has no private tier, and opening a link is not
 * consent to either. So it says what joining means and waits for a click.
 *
 * ## What it can say, and what it cannot
 *
 * Nothing about the group before the click, because the page has not looked the
 * token up and should not: a preview would be a second, unrated way to test
 * tokens. After the click, the group's name, since the holder of a live link is
 * somebody an admin chose to let knock.
 *
 * Every bad token (malformed, unknown, expired, revoked, used up) is one answer,
 * "not available". A full group is the one refusal that explains itself. A
 * response that is not about the link at all (the daily cap, an expired
 * session, a server error, no network) says so, and never "not available".
 */

import * as React from 'react';
import { Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import {
  redeemJoinLinkResponseSchema,
  type RedeemJoinLinkResponse,
} from '@/lib/framework/resparkable/ui/payloads';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

type State =
  | { kind: 'offered' }
  | { kind: 'joining' }
  | { kind: 'answered'; answer: RedeemJoinLinkResponse }
  /** The request did not get an answer about the link, so the link may be fine. */
  | { kind: 'failed'; title: string; description: string };

/**
 * A response that says nothing about the link. Told apart from "not available"
 * because that answer makes people throw away a link that would have worked:
 * the daily cap resets, a session can be renewed, and a server error passes.
 * A 400 is not here: it is a malformed token, which IS a bad link.
 */
function failureFor(status: number): State | null {
  if (status === 429) {
    return {
      kind: 'failed',
      title: 'Too many tries today',
      description: 'You have used a lot of join links today. Try this one again tomorrow.',
    };
  }
  if (status === 401) {
    return {
      kind: 'failed',
      title: 'You are signed out',
      description: 'Sign in again, then open this link again.',
    };
  }
  if (status >= 500) {
    return {
      kind: 'failed',
      title: 'Something went wrong',
      description: 'The link may still work. Try again in a moment.',
    };
  }
  return null;
}

export function JoinGroup({ token }: { token: string }): React.ReactElement {
  const [state, setState] = React.useState<State>({ kind: 'offered' });

  async function join(): Promise<void> {
    setState({ kind: 'joining' });
    const unknown: State = { kind: 'answered', answer: { outcome: 'unknown' } };
    try {
      const response = await fetch(RESPARKABLE_API.JOIN_GROUP, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const failure = failureFor(response.status);
      if (failure) {
        setState(failure);
        return;
      }
      const payload: unknown = await response.json();
      if (!response.ok || !isSuccess(payload)) {
        setState(unknown);
        return;
      }

      // Parsed, never cast: a network response on a screen that tells somebody
      // they joined something.
      const parsed = redeemJoinLinkResponseSchema.safeParse(payload.data);
      setState(parsed.success ? { kind: 'answered', answer: parsed.data } : unknown);
    } catch {
      // No response at all: a network failure, which says nothing about the link.
      setState({
        kind: 'failed',
        title: 'Could not reach the server',
        description: 'Check your connection and try again. The link may still work.',
      });
    }
  }

  if (state.kind === 'answered') return <Answer answer={state.answer} />;

  if (state.kind === 'failed') {
    return (
      <EmptyState
        icon={Users}
        title={state.title}
        description={state.description}
        action={
          <Button variant="outline" onClick={() => setState({ kind: 'offered' })}>
            Back
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      icon={Users}
      title="You have a link to join a group"
      description="A group workspace is shared with everyone in it. Anything you add there can be seen by every other member, and anything they add is visible to you. Your own workspace stays private and separate."
      action={
        <Button onClick={() => void join()} disabled={state.kind === 'joining'}>
          {state.kind === 'joining' ? 'Joining…' : 'Join the group'}
        </Button>
      }
    />
  );
}

function Answer({ answer }: { answer: RedeemJoinLinkResponse }): React.ReactElement {
  const name = answer.groupName ?? 'the group';
  const manage = answer.groupId ? (
    <Button asChild variant="outline">
      <a href={RESPARKABLE_ROUTES.group(answer.groupId)}>Go to the group</a>
    </Button>
  ) : undefined;
  const groups = (
    <Button asChild variant="outline">
      <a href={RESPARKABLE_ROUTES.GROUPS}>Your groups</a>
    </Button>
  );

  switch (answer.outcome) {
    case 'joined':
      return (
        <EmptyState
          icon={Users}
          title={`You have joined ${name}`}
          description="Your own workspace stays private and separate."
          action={manage}
        />
      );
    case 'already_member':
      return <EmptyState icon={Users} title="You are already in this group" action={manage} />;
    case 'requested':
      return (
        <EmptyState
          icon={Users}
          title={`You have asked to join ${name}`}
          description="An admin of the group needs to let you in. Until then you cannot see anything in it. You can withdraw your request from your groups."
          action={groups}
        />
      );
    case 'already_requested':
      return (
        <EmptyState
          icon={Users}
          title="You have already asked to join this group"
          description="An admin of the group needs to let you in."
          action={groups}
        />
      );
    case 'group_full':
      return (
        <EmptyState
          icon={Users}
          title={`${name} is full`}
          description="The group has reached its member limit, so you could not join. Its admins can see that somebody was turned away."
        />
      );
    case 'unknown':
      return (
        <EmptyState
          icon={Users}
          title="This link is not available"
          description="It may have expired, been used up, or been withdrawn."
        />
      );
  }
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
