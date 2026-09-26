/**
 * Join links: a way into a group that names nobody (§23.11, phase 57).
 *
 * ## A forwarded join link is the whole thing
 *
 * `services/group-invites.ts` issues a token too, and the two look alike. They
 * are not. An invitation names an address, and accepting it needs a session on
 * that address, so a forwarded invitation email is useless. A join link names
 * nobody: whoever is signed in and holds it can use it. That makes it a bearer
 * credential to a whole workspace, and it takes §13's public-link discipline
 * rather than the invite's: 192 bits, sha256 at rest, a prefix for the UI, an
 * expiry, revocation, and a use limit.
 *
 * ## What holding one gets you
 *
 * At most a `member` role, never `admin`, and for a `request` link not even
 * that: a pending row that resolves to no scope at all until an admin approves
 * it. The role is fixed when the link is minted and refused at two layers, the
 * schema and `mintJoinLink`, so a caller that skips the schema still cannot mint
 * an admin link.
 *
 * ## One answer for every bad token
 *
 * Malformed, unknown, expired, revoked and used up are all `unknown`, for the
 * reason every token path in this tier gives: anything distinguishable is an
 * oracle about which links once existed and which groups do. A full group is
 * the one failure that explains itself, because the person holding a live link
 * is somebody an admin chose to let knock.
 *
 * @see .context/framework/resparkable/phase-57-plan.md
 */

import { randomBytes } from 'crypto';

import { hashShareToken } from '@/lib/framework/resparkable/access/resolve';
import {
  approveJoinRequest,
  createJoinLink,
  deleteJoinRequest,
  findJoinLinkByTokenHash,
  listJoinLinks,
  redeemJoinLink,
  revokeJoinLink,
} from '@/lib/framework/resparkable/repo/groups';
import {
  permissionsFor,
  resolveGroupMembership,
  type MembershipRefusal,
} from '@/lib/framework/resparkable/services/membership';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import type { CreateJoinLinkInput } from '@/lib/framework/resparkable/validations';
import { env } from '@/lib/env';
import { logger } from '@/lib/logging';
import { isShareActive } from '@/lib/utils/share-window';

/** The roles a join link may carry. `admin` is absent on purpose. */
export const JOIN_LINK_ROLES = ['member', 'viewer'] as const;
export type JoinLinkRole = (typeof JOIN_LINK_ROLES)[number];

export const JOIN_LINK_APPROVALS = ['open', 'request'] as const;
export type JoinLinkApproval = (typeof JOIN_LINK_APPROVALS)[number];

/** How many characters of the token the admin's list shows. */
const TOKEN_PREFIX_LENGTH = 6;

/** 24 random bytes, base64url: the same 192 bits as a share link. Never a cuid. */
function mintToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * The default approval for a role: `request` for anything that can write,
 * `open` for a viewer (§23.11). The admin may choose either for either.
 */
export function defaultApprovalFor(role: JoinLinkRole): JoinLinkApproval {
  return role === 'viewer' ? 'open' : 'request';
}

/** Why a join-link action was refused. */
export type JoinLinkRefusal = MembershipRefusal | 'admin_link';

/** A link as the admin's list shows it. Never the digest. */
export interface JoinLinkView {
  id: string;
  tokenPrefix: string;
  role: string;
  approval: string;
  maxUses: number | null;
  useCount: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

function toView(link: JoinLinkView): JoinLinkView {
  // An allowlisted projection, never the row: `tokenHash` is the digest of a
  // live credential and there is no screen that needs it.
  return {
    id: link.id,
    tokenPrefix: link.tokenPrefix,
    role: link.role,
    approval: link.approval,
    maxUses: link.maxUses,
    useCount: link.useCount,
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt,
    createdAt: link.createdAt,
  };
}

async function requireAdmin(
  actorUserId: string,
  groupId: string
): Promise<{ ok: true } | { ok: false; reason: MembershipRefusal }> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };
  if (!permissionsFor(resolved.scope.role).administer) {
    return { ok: false, reason: 'not_an_admin' };
  }
  return { ok: true };
}

export type MintJoinLinkResult =
  | { ok: true; link: JoinLinkView; token: string; url: string }
  | { ok: false; reason: JoinLinkRefusal };

/**
 * Mint a join link. Admin only.
 *
 * The token is returned here and nowhere else, ever: only its digest is stored,
 * so an admin who loses it mints another and revokes the first.
 */
export async function mintJoinLink(
  actorUserId: string,
  groupId: string,
  input: CreateJoinLinkInput,
  now: Date = new Date()
): Promise<MintJoinLinkResult> {
  // The schema already refuses `admin`. This is the second layer, for a caller
  // that reaches the service without going through the schema. Checked before
  // membership, so the answer does not depend on who asked.
  if (!(JOIN_LINK_ROLES as readonly string[]).includes(input.role)) {
    return { ok: false, reason: 'admin_link' };
  }

  const allowed = await requireAdmin(actorUserId, groupId);
  if (!allowed.ok) return allowed;

  const token = mintToken();
  const link = await createJoinLink({
    groupId,
    tokenHash: hashShareToken(token),
    tokenPrefix: token.slice(0, TOKEN_PREFIX_LENGTH),
    role: input.role,
    approval: input.approval ?? defaultApprovalFor(input.role),
    maxUses: input.maxUses ?? null,
    expiresAt:
      input.expiry.kind === 'never'
        ? null
        : new Date(now.getTime() + input.expiry.days * 24 * 60 * 60 * 1000),
  });

  logger.info('Resparkable group join link minted', {
    groupId,
    role: link.role,
    approval: link.approval,
  });

  return {
    ok: true,
    link: toView(link),
    token,
    url: `${env.NEXT_PUBLIC_APP_URL}${RESPARKABLE_ROUTES.groupJoin(token)}`,
  };
}

/** Every link the group has, for the admin's list. */
export async function listJoinLinksForAdmin(
  actorUserId: string,
  groupId: string
): Promise<{ ok: true; links: JoinLinkView[] } | { ok: false; reason: JoinLinkRefusal }> {
  const allowed = await requireAdmin(actorUserId, groupId);
  if (!allowed.ok) return allowed;

  return { ok: true, links: (await listJoinLinks(groupId)).map(toView) };
}

/** Revoke a link. Admin only, and idempotent. */
export async function revokeGroupJoinLink(
  actorUserId: string,
  groupId: string,
  linkId: string,
  now: Date = new Date()
): Promise<{ ok: true } | { ok: false; reason: JoinLinkRefusal }> {
  const allowed = await requireAdmin(actorUserId, groupId);
  if (!allowed.ok) return allowed;

  await revokeJoinLink(groupId, linkId, now);
  logger.info('Resparkable group join link revoked', { groupId });
  return { ok: true };
}

/** What the join page renders. */
export type RedeemJoinLinkResult =
  | {
      ok: true;
      outcome: 'joined' | 'requested' | 'already_member' | 'already_requested';
      groupId: string;
      groupName: string;
    }
  | { ok: false; reason: 'group_full'; groupName: string }
  | { ok: false; reason: 'unknown' };

/**
 * Redeem a join link as the signed-in user.
 *
 * Reads nothing in the group. It writes a membership row, or does not, and
 * hands back the group's name and id; the space then resolves membership on its
 * own request through the one resolver. A pending row resolves to nothing there,
 * so a `request` link's holder can read no more after this than before.
 */
export async function redeemJoinLinkToken(
  userId: string,
  token: string,
  now: Date = new Date()
): Promise<RedeemJoinLinkResult> {
  const link = await findJoinLinkByTokenHash(hashShareToken(token));
  if (!link || !isShareActive(link, now)) return { ok: false, reason: 'unknown' };
  // Used up is checked inside the repo, after "are you already in", so that
  // somebody already in or already waiting is told so rather than told the link
  // is dead.
  const { kind: outcome } = await redeemJoinLink(link, userId, now);

  if (outcome === 'spent') return { ok: false, reason: 'unknown' };
  if (outcome === 'group_full') {
    logger.info('Resparkable group join refused: the group is full', { groupId: link.groupId });
    return { ok: false, reason: 'group_full', groupName: link.group.name };
  }

  logger.info('Resparkable group join link redeemed', { groupId: link.groupId, outcome });
  return { ok: true, outcome, groupId: link.groupId, groupName: link.group.name };
}

export type JoinRequestRefusal = MembershipRefusal | 'group_full';

/** Let somebody who asked to join in. Admin only; the cap is re-checked. */
export async function approveGroupJoinRequest(
  actorUserId: string,
  groupId: string,
  targetUserId: string,
  now: Date = new Date()
): Promise<{ ok: true } | { ok: false; reason: JoinRequestRefusal }> {
  const allowed = await requireAdmin(actorUserId, groupId);
  if (!allowed.ok) return allowed;

  const outcome = await approveJoinRequest(groupId, targetUserId, now);
  if (outcome === 'no_such_request') return { ok: false, reason: 'no_such_member' };
  if (outcome === 'group_full') return { ok: false, reason: 'group_full' };

  logger.info('Resparkable group join request approved', { groupId });
  return { ok: true };
}

/** Turn a request down. Admin only; the pending row is deleted and nothing is kept. */
export async function rejectGroupJoinRequest(
  actorUserId: string,
  groupId: string,
  targetUserId: string
): Promise<{ ok: true } | { ok: false; reason: JoinRequestRefusal }> {
  const allowed = await requireAdmin(actorUserId, groupId);
  if (!allowed.ok) return allowed;

  if (!(await deleteJoinRequest(groupId, targetUserId))) {
    return { ok: false, reason: 'no_such_member' };
  }

  logger.info('Resparkable group join request rejected', { groupId });
  return { ok: true };
}
