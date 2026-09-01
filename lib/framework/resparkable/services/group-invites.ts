/**
 * Group invitations: the token that is the only thing between a stranger and a
 * group's whole brain.
 *
 * ## Why this is not `services/invites.ts` with a different table
 *
 * That file opens by saying the invite grants nothing, and means something
 * precise by it: a share **grant** is already live for the address it names, so
 * the token only binds an account to a relationship that already works. A leaked
 * digest is not a credential, because the grant is reachable by mailbox anyway.
 *
 * Here the same sentence means the opposite thing. **The invitation grants
 * nothing until it is accepted**, and accepting creates write access to an
 * entire shared workspace. There is no email-matching fallback and there must
 * never be one: `resolveGroupSpaceScope` reads memberships and nothing else, so
 * an address alone resolves to no scope at all. The token is what turns an
 * invitation into a membership, which makes it a real credential in a way a
 * share invite's is not.
 *
 * The shape is still §13's, deliberately (§23.3 asks for exactly this): 192 bits
 * from `randomBytes(24).toString('base64url')`, sha256 at rest through the same
 * `hashShareToken`, `grantExpirySchema`'s 30-day default and 365-day ceiling,
 * `isShareActive` for the window, an identical response whether or not the
 * address has an account, and never `Verification`. What is not shared is the
 * code path, because one function whose comment has to explain both meanings is
 * a function somebody will later simplify in the wrong direction.
 *
 * ## What the email may not contain
 *
 * Nothing about the group's content. The group's NAME is included, unlike a
 * share invite's item title, because "join Study Group B" is the only version of
 * this message somebody can act on, and the name is already what every member
 * tells people. See `components/resparkable/emails/group-invite.tsx`.
 *
 * ## Sending is not what makes the invitation exist
 *
 * `issueGroupInvite` writes the row and mints the token; the send is reported,
 * never thrown. A provider outage leaves an invitation an admin can re-send,
 * rather than rolling back a decision they already made.
 *
 * @see lib/framework/resparkable/services/invites.ts: the share half, and the
 *      file this copies in shape and deliberately not in semantics
 */

import { randomBytes } from 'crypto';

import { GroupInviteEmail } from '@/components/resparkable/emails/group-invite';
import { hashShareToken } from '@/lib/framework/resparkable/access/resolve';
import {
  acceptInviteAndJoin,
  findInviteByTokenHash,
  listGroupInvites,
  revokeInvite,
  upsertInvite,
} from '@/lib/framework/resparkable/repo/groups';
import { findOwnerContact } from '@/lib/framework/resparkable/repo/owner-contact';
import { spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import {
  permissionsFor,
  resolveGroupMembership,
  type MembershipRefusal,
} from '@/lib/framework/resparkable/services/membership';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import type { CreateGroupInviteInput } from '@/lib/framework/resparkable/validations';
import { sendEmail } from '@/lib/email/send';
import { env } from '@/lib/env';
import { logger } from '@/lib/logging';
import { maskEmail } from '@/lib/security/redact';
import { isShareActive } from '@/lib/utils/share-window';

/**
 * 24 random bytes, base64url. The same 192 bits a share link gets, and here it
 * matters more than it does there: this one really is the thing that grants
 * access on acceptance. Deliberately not a cuid, which is timestamp-prefixed and
 * monotonic, precisely the wrong shape for a value whose defence is
 * unguessability.
 */
function mintInviteToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Resolve the boundary's expiry choice into a date. Mirrors `services/grants.ts`. */
function resolveExpiry(expiry: CreateGroupInviteInput['expiry'], now: Date): Date | null {
  if (expiry.kind === 'never') return null;
  return new Date(now.getTime() + expiry.days * 24 * 60 * 60 * 1000);
}

/** Why an invitation was not issued. Every one is a refusal the UI can explain. */
export type InviteRefusal = MembershipRefusal | 'already_a_member';

export type IssueInviteResult =
  { ok: true; inviteId: string; sent: boolean } | { ok: false; reason: InviteRefusal };

/**
 * Issue an invitation and email it.
 *
 * **Admin only.** §23.3 gives invitation to admins alone, and it is checked here
 * rather than in the route because the same rule has to hold on the join-link
 * path phase 57 adds.
 *
 * The response says nothing about whether the address has an account, for §13's
 * reason: anything distinguishable turns "invite somebody" into an
 * account-existence oracle anybody can query one address at a time. `sent`
 * reports only whether an email left the building, which is the admin's own
 * screen's business and not a fact about the invitee.
 */
export async function issueGroupInvite(
  actorUserId: string,
  groupId: string,
  input: CreateGroupInviteInput,
  now: Date = new Date()
): Promise<IssueInviteResult> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };
  if (!permissionsFor(resolved.scope.role).administer) {
    return { ok: false, reason: 'not_an_admin' };
  }

  const token = mintInviteToken();
  const invite = await upsertInvite({
    groupId,
    email: input.email,
    role: input.role,
    invitedByUserId: actorUserId,
    inviteTokenHash: hashShareToken(token),
    expiresAt: resolveExpiry(input.expiry, now),
  });

  // The inviter's own contact details, read from their PERSONAL space. This is a
  // legitimate `spaceScope()` mint site: the id comes from the session, and the
  // read is of the actor's own row rather than of anything in the group.
  const sender = await findOwnerContact(spaceScope(actorUserId));

  const result = sender
    ? await sendEmail({
        to: input.email,
        // The group's name, and nothing that is in it. See the file header.
        subject: `${sender.name ?? sender.email} invited you to join ${resolved.membership.group.name}`,
        react: GroupInviteEmail({
          inviterName: sender.name ?? sender.email,
          groupName: resolved.membership.group.name,
          inviteeEmail: input.email,
          role: input.role,
          acceptUrl: `${env.NEXT_PUBLIC_APP_URL}${RESPARKABLE_ROUTES.groupInvite(token)}`,
          expiresAt: invite.expiresAt,
        }),
      })
    : { success: false as const };

  if (!result.success) {
    // Reported, never thrown. An invitation nobody was told about is an
    // invitation an admin can re-send; a throw would roll back a decision they
    // already made and leave nothing behind to re-send.
    //
    // No address in the log line, here or in the success case: one person's
    // contact details in another person's infrastructure, for the life of the
    // log.
    logger.warn('Resparkable group invite failed to send', { groupId });
    return { ok: true, inviteId: invite.id, sent: false };
  }

  logger.info('Resparkable group invite sent', { groupId, role: input.role });
  return { ok: true, inviteId: invite.id, sent: true };
}

/** Withdraw an outstanding invitation. Admin only, and idempotent. */
export async function revokeGroupInvite(
  actorUserId: string,
  groupId: string,
  inviteId: string,
  now: Date = new Date()
): Promise<{ ok: true } | { ok: false; reason: InviteRefusal }> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };
  if (!permissionsFor(resolved.scope.role).administer) {
    return { ok: false, reason: 'not_an_admin' };
  }

  // A second revoke moves nothing and still answers `ok`. The alternative is a
  // 404 on a button that did exactly what it said the first time.
  await revokeInvite(groupId, inviteId, now);
  logger.info('Resparkable group invite revoked', { groupId });
  return { ok: true };
}

/** Outstanding invitations, for the admin's own list. Never leaves the group. */
export async function listInvitesForAdmin(
  actorUserId: string,
  groupId: string
): Promise<
  | {
      ok: true;
      invites: Array<{
        id: string;
        email: string;
        role: string;
        invitedAt: Date;
        expiresAt: Date | null;
        revokedAt: Date | null;
        acceptedAt: Date | null;
      }>;
    }
  | { ok: false; reason: InviteRefusal }
> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };
  if (!permissionsFor(resolved.scope.role).administer) {
    return { ok: false, reason: 'not_an_admin' };
  }

  const invites = await listGroupInvites(groupId);
  return {
    ok: true,
    // An allowlisted projection, never the row. `inviteTokenHash` is the digest
    // of a live credential and there is no screen that needs it.
    invites: invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      invitedAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      revokedAt: invite.revokedAt,
      acceptedAt: invite.acceptedAt,
    })),
  };
}

/** What the accept page renders. Every failure carries a reason it can explain. */
export type AcceptGroupInviteResult =
  | { ok: true; groupId: string; groupName: string; spaceId: string; alreadyMember: boolean }
  | { ok: false; reason: 'unknown' }
  | { ok: false; reason: 'wrong_account'; expectedEmail: string };

/**
 * Accept an invitation: bind the account and create the membership.
 *
 * ## The address comparison, and why the mismatch answer is masked
 *
 * Somebody signed in as a different account cannot accept, which is what makes a
 * forwarded email useless. They are told **which** address it was for, masked,
 * because the reader needs enough to recognise their own mailbox and a stranger
 * must not be handed a working address. `maskEmail` resolves the two: `a***@e***.com`
 * is recognisable and not writable-to. Same treatment as `acceptInvite`.
 *
 * ## `unknown` covers more than "no such token"
 *
 * A malformed token, an unknown one, a revoked invitation, an expired one and
 * one already spent all return the same `unknown`. Anything distinguishable
 * turns this page into an oracle about which invitations once existed, and here
 * that oracle would also enumerate which groups exist.
 *
 * ## What this deliberately does not do
 *
 * It does not read anything in the group. It binds the account and hands back
 * the ref; the page then redirects to the group's space, which resolves
 * membership on its own request through the one resolver. Reading here would be
 * a second, differently authorised path to the same content.
 */
export async function acceptGroupInvite(
  viewer: { userId: string; email: string },
  token: string,
  now: Date = new Date()
): Promise<AcceptGroupInviteResult> {
  const invite = await findInviteByTokenHash(hashShareToken(token));
  if (!invite || invite.acceptedAt !== null || !isShareActive(invite, now)) {
    return { ok: false, reason: 'unknown' };
  }

  if (invite.email !== viewer.email.toLowerCase()) {
    logger.info('Resparkable group invite opened by the wrong account', {
      groupId: invite.groupId,
    });
    return { ok: false, reason: 'wrong_account', expectedEmail: maskEmail(invite.email) };
  }

  const member = await acceptInviteAndJoin(
    {
      id: invite.id,
      groupId: invite.groupId,
      role: invite.role,
      invitedByUserId: invite.invitedByUserId,
    },
    viewer.userId,
    now
  );
  // Lost the compare-and-set: revoked, or spent by a parallel request between
  // the lookup and the write. Same answer as an unknown token.
  if (!member) return { ok: false, reason: 'unknown' };

  logger.info('Resparkable group invite accepted', { groupId: invite.groupId });

  return {
    ok: true,
    groupId: invite.groupId,
    groupName: invite.group.name,
    spaceId: invite.group.spaceId,
    // True when the row was already there: a second invitation to somebody
    // already in. The page says "you are already in this group" rather than
    // pretending something happened.
    alreadyMember: member.joinedAt !== null && member.createdAt < now,
  };
}
