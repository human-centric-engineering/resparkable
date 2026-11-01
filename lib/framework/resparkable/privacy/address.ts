/**
 * The one rule for matching a person by email address (plan.md phase 66).
 *
 * Resparkable addresses three kinds of row to a mailbox rather than to an
 * account: a share invite (`ResparkableGrant.granteeEmail`), a group invitation
 * (`ResparkableGroupInvite.email`), and the account a grant is bound to when it
 * is issued (`findAccountIdForEmail`). Each is a statement by somebody else
 * that the mailbox's owner should have something. Six places read them by
 * address: access (`viewerFor`), the two accept flows, `findAccountIdForEmail`,
 * subject export and erasure. They used to agree only by habit, and they did
 * not agree on the question that matters.
 *
 * ## Only a verified address matches
 *
 * An account proves it owns its address by clicking the link sent to it. Until
 * it has, the address is only what was typed at sign-up, and with
 * `REQUIRE_EMAIL_VERIFICATION=false` anyone can open an account under
 * somebody else's. Matching on that address would let them read what was
 * shared with the real owner, accept their invitations, receive them in an
 * export and delete them on erasure. So an unverified account matches by
 * address nothing at all, which is the rule core applies to its own address-
 * keyed rows (`ErasureExternalContext.emailVerified`, `lib/privacy/erasure-hooks.ts`).
 *
 * Under the production default an unverified account cannot sign in, so this
 * changes nothing there. On a deploy that turns verification off, a person
 * confirms their address from their account page and the shares addressed to
 * it appear.
 *
 * ## The comparison
 *
 * Exact, on the trimmed and lower-cased address, because that is how every
 * writer stores one (`granteeEmailSchema`). A `User.email` is whatever the
 * account was created with, so it is normalised here rather than trusted.
 */

/** The fields of an account this rule reads. A session user and a `User` row both fit. */
export interface AddressOwner {
  email: string | null | undefined;
  emailVerified: boolean;
}

/**
 * An address in the form every writer stores it. Not a permission: it says
 * whether two addresses are the same mailbox, never whether an account may
 * match by it. That is {@link matchableAddress}.
 */
export function normaliseAddress(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The address to match this account's address-keyed rows on, or `null` when
 * it may match none: no address, or one it has not proven it owns.
 */
export function matchableAddress(account: AddressOwner): string | null {
  if (!account.emailVerified || !account.email) return null;
  const address = normaliseAddress(account.email);
  return address === '' ? null : address;
}
