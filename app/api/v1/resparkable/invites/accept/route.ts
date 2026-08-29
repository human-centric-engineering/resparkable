/**
 * POST /api/v1/resparkable/invites/accept — bind my account to a share.
 *
 * The grantee's side of an invite, and the one route under a `/grants`-adjacent
 * name that the **owner** never calls.
 *
 * ## What accepting actually does
 *
 * Not "grant access" — the grant is already live for the address it names,
 * because the access layer matches on the email as well as on a bound account.
 * Accepting connects an **account** to that relationship, so it survives the
 * person later changing their address, and so the owner can tell a share
 * somebody has engaged with from one still sitting in a mailbox.
 *
 * ## Why a session is required, and what it proves
 *
 * The token names a grant; the **session proves the address**. That split is
 * what makes a forwarded invite email useless: a different signed-in person
 * gets `wrong_account` and a masked address, and nothing is written.
 *
 * §13 asks for both halves of that — a different signed-in user cannot accept,
 * and the wrong-user path does not leak the target address unmasked. The mask
 * is the resolution of a real tension: the reader needs to know which of their
 * accounts to use, and a stranger must not be handed a working address.
 *
 * ## Every other failure is one failure
 *
 * A malformed token, an unknown one, a revoked grant, an expired one and a token
 * already spent all return the same 404. Anything distinguishable turns this
 * into an oracle about which invitations once existed.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { acceptInvite } from '@/lib/framework/resparkable/services/invites';
import { acceptInviteSchema } from '@/lib/framework/resparkable/validations';

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const body = await validateRequestBody(request, acceptInviteSchema);

  const result = await acceptInvite(
    { userId: session.user.id, email: session.user.email },
    body.token
  );

  if (!result.ok && result.reason === 'unknown') {
    throw new NotFoundError('Not found');
  }

  if (!result.ok) {
    log.info('Resparkable share invite opened by the wrong account');
    // A 200, not a 4xx: this is a state the page renders and explains, not an
    // error. The address is masked by the service before it reaches here.
    return successResponse({
      accepted: false,
      reason: 'wrong_account' as const,
      expectedEmail: result.expectedEmail,
    });
  }

  log.info('Resparkable share invite accepted', { entityType: result.entityType });

  return successResponse({
    accepted: true,
    entityType: result.entityType,
    entityId: result.entityId,
    alreadyAccepted: result.alreadyAccepted,
  });
});
