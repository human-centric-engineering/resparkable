/**
 * POST /api/v1/resparkable/grants/[id]/invite — email the person you shared with.
 *
 * **Separate from creating the grant, on purpose.** `POST /grants` writes the
 * row; this sends the message. Keeping them apart means a mail-provider outage
 * leaves working access rather than a person told they have access and does not,
 * and it makes "send it again" a button rather than a second grant.
 *
 * **The invite grants nothing on its own.** The grant is already live for the
 * address it names — the access layer matches on the email — so the token only
 * binds an account to a relationship that already exists. A forwarded email is
 * useless without that mailbox, which is why this is not treated as a credential
 * being issued.
 *
 * **The response never says whether the address has an account.** It reports
 * only whether an email left the building, which is the owner's own question
 * about their own action. §13's identical-shape rule is about account existence,
 * and that answer is still nowhere in this response.
 *
 * Rate-limited at 20/day per user by the `resparkable-invite` tier. Without it
 * this endpoint is a spam cannon with the deployment's domain on it — one
 * account, an unbounded list of addresses, and a message that looks like it came
 * from a real product. That is the reason for the cap, and it is why the cap is
 * daily rather than per-minute: the abuse is volume over time, not burst.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { sendGrantInvite } from '@/lib/framework/resparkable/services/invites';

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const outcome = await sendGrantInvite(scope, id);

  // Not this owner's grant, gone, or revoked. A revoked grant must not be able
  // to send a fresh invite — that would undo a revocation with a button
  // somebody forgot to grey out.
  if (outcome === 'no_grant') throw new NotFoundError('Grant not found');

  log.info('Resparkable share invite requested', { id, outcome });

  // `sent: false` covers a provider failure and an erased owner alike. The
  // client's answer to both is the same: offer to try again.
  return successResponse({ sent: outcome === 'sent' });
});
