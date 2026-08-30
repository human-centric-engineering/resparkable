/**
 * Share invites — the email that tells somebody a grant exists.
 *
 * ## The invite grants nothing, and that is the whole security model
 *
 * A share **link** is a bearer credential: holding the URL is access, which is
 * why its token is 192 bits, hashed at rest, shown once and revocable. An
 * invite token is not that. The grant it points at is **already live for the
 * address it was issued to** — `granteeClauses` in `access/store.ts` matches on
 * the email, so somebody signed in with that mailbox can already read the item
 * before ever opening the email. All the token does is *bind an account* to the
 * relationship, so the grant survives that person later changing their address.
 *
 * Two consequences worth stating rather than discovering:
 *
 *   • **A forwarded invite email is useless.** Accepting requires being signed
 *     in as the address the grant names. Somebody else clicking the link is told
 *     which address it was for — masked — and nothing else happens.
 *   • **A leaked database of invite digests is not a set of live credentials.**
 *     Each one still needs its mailbox.
 *
 * The token is hashed anyway. Not because holding one is access, but because a
 * dump full of live ones would let an attacker who *does* control some of those
 * mailboxes bind accounts silently, and there is no reason to make that cheaper.
 *
 * ## Sending is not what makes the grant work
 *
 * `issueGrant` writes the row; this sends the message. Keeping them separate is
 * what means a provider outage leaves working access rather than a person told
 * they have access and does not — and it is why a send failure here is reported,
 * never thrown.
 *
 * ## What the email may not contain
 *
 * **Not the item's title.** A subject line lands in a preview pane, a lock
 * screen, a shared screen and a mail provider's index. The whole point of the
 * access layer is that content sits behind a resolution; a title in a subject
 * line is the one copy of it that never was.
 */

import { hashShareToken } from '@/lib/framework/resparkable/access/resolve';
import { ShareInviteEmail } from '@/components/resparkable/emails/share-invite';
import {
  acceptGrant,
  findGrantByInviteTokenHash,
  findOwnGrant,
  stampInviteToken,
} from '@/lib/framework/resparkable/repo/grants';
import { findOwnerContact } from '@/lib/framework/resparkable/repo/owner-contact';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import { sendEmail } from '@/lib/email/send';
import { env } from '@/lib/env';
import { logger } from '@/lib/logging';
import { maskEmail } from '@/lib/security/redact';
import { isShareActive } from '@/lib/utils/share-window';
import { randomBytes } from 'crypto';

/** What each shareable type is called in an email. Never the item's own title. */
const KIND_LABEL: Record<string, string> = {
  area: 'life area',
  goal: 'goal',
  project: 'project',
  review: 'review',
  board: 'board',
  task: 'task',
};

/**
 * 24 random bytes, base64url — the same shape as a share-link token.
 *
 * Deliberately **not** a cuid, for the reason `services/sharing.ts` gives:
 * cuids are timestamp-prefixed and monotonic, which is excellent for a primary
 * key and precisely wrong for a value whose defence is unguessability. This one
 * needs it less than a share link does, and gets it anyway, because "less" is
 * not a reason to hand out something guessable.
 */
function mintInviteToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Why an invite was not sent. Never surfaced differently to the caller. */
export type InviteOutcome = 'sent' | 'send_failed' | 'no_grant' | 'no_sender';

/**
 * Mint a token for a grant and email its address.
 *
 * **The outcome is for the log and the owner's own screen, not for a security
 * decision.** Whether an address has an account still never reaches the caller;
 * this reports only whether an email left the building.
 *
 * Returns `no_grant` for a grant that is not this owner's, does not exist, or is
 * no longer live — a revoked grant must not be able to send a fresh invite, or
 * revocation would be undone by a button somebody forgot to grey out.
 */
export async function sendGrantInvite(
  scope: SpaceScope,
  grantId: string,
  now: Date = new Date()
): Promise<InviteOutcome> {
  const grant = await findOwnGrant(scope, grantId);
  if (!grant || !isShareActive(grant, now)) return 'no_grant';

  const sender = await findOwnerContact(scope);
  // An erased owner whose grant row outlived them, or a race with erasure.
  // Nothing to send, and nobody to send it from.
  if (!sender) return 'no_sender';

  const token = mintInviteToken();
  const stamped = await stampInviteToken(scope, grantId, hashShareToken(token), now);
  if (!stamped) return 'no_grant';

  const result = await sendEmail({
    to: grant.granteeEmail,
    // The kind of thing, never the thing. See this file's header.
    subject: `${sender.name ?? sender.email} shared a ${KIND_LABEL[grant.entityType] ?? 'item'} with you`,
    react: ShareInviteEmail({
      sharerName: sender.name ?? sender.email,
      inviteeEmail: grant.granteeEmail,
      itemKind: KIND_LABEL[grant.entityType] ?? 'item',
      canComment: grant.role === 'commenter',
      acceptUrl: `${env.NEXT_PUBLIC_APP_URL}${RESPARKABLE_ROUTES.invite(token)}`,
      expiresAt: grant.expiresAt,
    }),
  });

  if (!result.success) {
    // Reported, never thrown. The grant is already live for that address; a
    // failed email is a person who has access and has not been told, which is
    // recoverable by re-sending. A throw here would roll a working share back.
    logger.warn('Resparkable share invite failed to send', {
      entityType: grant.entityType,
      // The address is deliberately absent, here and in the success line
      // below: one person's contact details in another person's
      // infrastructure, for the life of the log.
    });
    return 'send_failed';
  }

  logger.info('Resparkable share invite sent', { entityType: grant.entityType });
  return 'sent';
}

/** What the accept page renders. Every failure carries a reason it can explain. */
export type AcceptResult =
  | {
      ok: true;
      entityType: string;
      entityId: string;
      /** True when the account was already bound — a re-opened email. */
      alreadyAccepted: boolean;
    }
  | { ok: false; reason: 'unknown' }
  | {
      ok: false;
      reason: 'wrong_account';
      /** Masked, always. See {@link acceptInvite}. */
      expectedEmail: string;
    };

/**
 * Bind a signed-in account to the grant an invite token names.
 *
 * ## The address comparison, and why the mismatch answer is masked
 *
 * §13 requires that a different signed-in user cannot accept an invite, and that
 * the wrong-user path does not leak the target address unmasked. Both matter and
 * they pull in opposite directions: the reader needs to be told *which* of their
 * accounts to use, and a stranger holding a forwarded email must not be handed a
 * working address. `maskEmail` is the resolution — `a***@e***.com` is enough to
 * recognise your own mailbox and not enough to write to somebody else's.
 *
 * Matching is case-insensitive because `granteeEmail` is stored lower-cased and
 * a session's address is whatever the account was created with.
 *
 * ## `unknown` covers more than "no such token"
 *
 * A malformed token, an unknown one, a revoked grant, an expired one and a
 * token already spent all return the same `unknown`. Anything distinguishable
 * turns this page into an oracle about which invitations once existed.
 */
export async function acceptInvite(
  viewer: { userId: string; email: string },
  token: string,
  now: Date = new Date()
): Promise<AcceptResult> {
  const grant = await findGrantByInviteTokenHash(hashShareToken(token));
  if (!grant || !isShareActive(grant, now)) return { ok: false, reason: 'unknown' };

  if (grant.granteeEmail !== viewer.email.toLowerCase()) {
    logger.info('Resparkable share invite opened by the wrong account', {
      entityType: grant.entityType,
    });
    return { ok: false, reason: 'wrong_account', expectedEmail: maskEmail(grant.granteeEmail) };
  }

  const alreadyAccepted = grant.granteeUserId === viewer.userId && grant.acceptedAt !== null;

  const accepted = await acceptGrant(grant.id, viewer.userId, now);
  // Revoked between the lookup and the write. Same answer as an unknown token.
  if (!accepted) return { ok: false, reason: 'unknown' };

  logger.info('Resparkable share invite accepted', { entityType: grant.entityType });

  return {
    ok: true,
    entityType: accepted.entityType,
    entityId: accepted.entityId,
    alreadyAccepted,
  };
}

// The accept path deliberately does NOT read the item. It binds the account and
// hands back the ref; the page then redirects to `/shared/…`, which resolves
// access on its own request. Reading here would be a second, differently
// authorised path to the same content — and it would mean minting an owner
// scope in a flow whose whole job is that somebody else's authority applies.
