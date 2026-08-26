/**
 * GET /api/v1/resparkable/public/[token] — the public reader's only endpoint.
 *
 * **Unauthenticated on purpose, and the only route in the tier that is.** The
 * bearer of the token is the credential; there is no session, no cookie, no
 * account. That makes this the single most exposed surface Resparkable has, so
 * four things about it are not negotiable.
 *
 * ## 1. Every failure looks the same
 *
 * Unknown token, malformed token, revoked link, expired link, and a link whose
 * item has since been deleted all return the same 404 with the same body. §16.4
 * asks for exactly that: anything else turns the response into an oracle
 * telling a stranger which tokens once existed, and roughly when.
 *
 * ## 2. `Referrer-Policy: no-referrer`
 *
 * **The token is in the path.** The deployment-wide policy is
 * `strict-origin-when-cross-origin`, which already strips the path from any
 * cross-origin request — so the token does not leak to an outbound link or a
 * remote image by default. `no-referrer` here goes one step further and sends
 * nothing at all, including the origin. It costs nothing on a page with no
 * analytics and no first-party navigation, and it means a shared note
 * containing a link to somewhere else tells that somewhere else nothing.
 *
 * ## 3. `X-Robots-Tag`
 *
 * `robots.txt` is advisory and, more importantly, does not remove URLs that are
 * already indexed. The header is the instruction that actually binds, so it is
 * set here as well as in the page's metadata — a crawler that fetches the API
 * directly (they do) gets told the same thing.
 *
 * ## 4. `Cache-Control: private, no-store`
 *
 * A share link is a per-token document, and the default cache header on this
 * codebase's responses is written for endpoints whose answer is the same for
 * everybody. A revoked link must stop working immediately, and it cannot if a
 * proxy is still serving the last 200.
 *
 * Rate-limited per IP (`lib/framework/resparkable/rate-limit.ts`), because the
 * only interesting thing to do here without a token is guess.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { readPublicShare } from '@/lib/framework/resparkable/services/sharing';
import { shareTokenSchema } from '@/lib/framework/resparkable/validations';

/**
 * The headers every response from this route carries, hit or miss.
 *
 * Applied to the 404 as well as the 200: a miss that skipped them would be a
 * crawlable, referrer-leaking, cacheable page — and would additionally be
 * distinguishable from a hit by its headers alone, which is the exact
 * distinction §16.4 is about.
 */
const PUBLIC_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'private, no-store, max-age=0',
} as const;

/** One 404, shared by every failure. Built as a literal so it cannot drift. */
function notFound(): Response {
  return Response.json(
    { success: false, error: { code: 'NOT_FOUND', message: 'This link is not available.' } },
    { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8', ...PUBLIC_HEADERS } }
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
  const log = await getRouteLogger(request);
  const { token } = await params;

  // Shape-checked before the database is touched. Not a correctness measure —
  // a malformed token would miss the unique index anyway — but this endpoint is
  // unauthenticated, and a length check is cheaper than an indexed miss.
  const parsed = shareTokenSchema.safeParse(token);
  if (!parsed.success) return notFound();

  const payload = await readPublicShare(parsed.data);
  if (!payload) return notFound();

  // The token is never logged, here or anywhere. A log line is the one place a
  // bearer credential most reliably outlives the system that issued it.
  log.info('Resparkable public share read', {
    entityType: payload.item.entityType,
    children: payload.children.length,
  });

  return successResponse(payload, undefined, { headers: PUBLIC_HEADERS });
}
