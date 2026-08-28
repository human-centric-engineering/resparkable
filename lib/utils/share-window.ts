/**
 * The one definition of "this share is still live".
 *
 * Two independent systems now issue revocable, expiring shares — admin
 * conversation shares (`lib/orchestration/access/conversation-access.ts`) and
 * Resparkable's grants and public links
 * (`lib/framework/resparkable/access/*`) — and they must not drift. The failure
 * that drift produces is silent and one-directional: a copy that forgets the
 * expiry check keeps serving a link its owner believed had lapsed, and nothing
 * in the response says so.
 *
 * The predicate itself is small enough that a second copy looks harmless. It
 * isn't. `revokedAt` and `expiresAt` are two independent reasons a share stops
 * working, both nullable, and the second is a comparison against a clock —
 * three chances to write `<` for `<=`, to check one field and not the other, or
 * to treat `null` as "expired" rather than "never expires". Every one of those
 * fails open.
 */

/** The two columns every revocable share carries, whatever table it lives in. */
export interface ShareWindow {
  revokedAt: Date | null;
  /** `null` means "never expires" — an explicit choice, never a default. */
  expiresAt: Date | null;
}

/**
 * Is this share currently usable?
 *
 * Active means: not revoked, AND either no expiry or an expiry in the future.
 * Revocation is checked first because it is the stronger statement — an owner
 * who revoked a link has said "stop", and that answer does not depend on a
 * clock.
 *
 * `<=` on the expiry, not `<`: a share expiring exactly now has expired. The
 * boundary is unreachable in practice and the reading is the one an owner
 * expects.
 *
 * @param now - Injectable for tests and for resolving a batch of shares against
 *   one instant, so a list cannot report two rows as live under different
 *   clocks. Defaults to the current time.
 */
export function isShareActive(share: ShareWindow, now: Date = new Date()): boolean {
  if (share.revokedAt !== null) return false;
  if (share.expiresAt !== null && share.expiresAt <= now) return false;
  return true;
}
