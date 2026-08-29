/**
 * Art. 15's other direction — the half `repo/**` cannot answer.
 *
 * ## The question the owner-scoped manifest could not ask
 *
 * `repo/subject-export.ts` answers "what is in this person's brain?", and every
 * source in it is `WHERE userId = $1`. Two things about a data subject live
 * outside that boundary by construction, and both have been sitting in that
 * file's comments as deferred:
 *
 *   • **What has been shared *with* them.** `ResparkableGrant.userId` is the
 *     owner, so a subject's own grants — the ones addressed to them — are on
 *     other people's rows.
 *   • **Comments they wrote** on somebody else's shared item. Keyed on
 *     `authorUserId`, on a row whose `userId` is the item's owner.
 *
 * Both are personal data about the subject and both are owed. Neither is
 * expressible as an owner query, which is why this file is in `access/**`:
 * reading across a person is exactly what this layer is named for, and routing
 * it through `repo/**` would mean giving that layer a way to say "not my rows".
 *
 * ## What is deliberately NOT in the answer
 *
 * **Not the content of what was shared with them.** A grant tells the subject
 * *that* Priya shared a project with them, on what terms, and when. It does not
 * put Priya's project in their export bundle — that is Priya's data, it is
 * behind a live grant that can be revoked, and an export file is a thing people
 * email around. The subject can read it in the product for as long as the grant
 * lasts; a permanent copy is not what Art. 15 asks for and would quietly turn
 * every share into a download.
 *
 * **Not the owner's identity beyond what the subject already sees.** They can
 * see who shared with them on `/shared-with-me`, so withholding it here would
 * be theatre — but the export carries the same fields that surface does and no
 * more.
 *
 * **Not the invite digest.** It is the digest of a credential and it tells the
 * subject nothing `acceptedAt` beside it does not.
 */

import { prisma } from '@/lib/db/client';
import type { ResparkableViewer } from '@/lib/framework/resparkable/access/types';

/** One item somebody else has shared with the subject. */
export interface SharedWithMeRecord {
  entityType: string;
  /**
   * The item's id, and deliberately not its title.
   *
   * The id is what makes the record checkable against the product — a subject
   * disputing "you say this was shared with me" can be shown the same row. The
   * title is the owner's content, and see the header for why content stays out.
   */
  entityId: string;
  role: string;
  includeTaskDetail: boolean;
  sharedAt: Date;
  acceptedAt: Date | null;
  invitedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/** One comment the subject wrote on somebody else's item. */
export interface AuthoredCommentRecord {
  entityType: string;
  entityId: string;
  body: string;
  editedAt: Date | null;
  createdAt: Date;
}

export interface ResparkableCrossSubjectData {
  /** Grants addressed to this person, by anybody. */
  sharedWithMe: SharedWithMeRecord[];
  /** Comments this person wrote, wherever they wrote them. */
  commentsIWrote: AuthoredCommentRecord[];
}

/**
 * Everything about this subject that lives on somebody else's rows.
 *
 * **Includes revoked and expired grants**, unlike `/shared-with-me`. That
 * surface is a place to work from and a withdrawn share is not part of it; this
 * is a record of what was done with the subject's personal data, and "somebody
 * shared a project with you last March and withdrew it in April" is exactly the
 * kind of thing a subject-access request is for.
 *
 * Matched on **both** the account id and the lower-cased address, the same pair
 * `granteeClauses` matches on — an unaccepted invite has only the address, and
 * an export that dropped those would silently omit the grants most likely to
 * have been forgotten about.
 */
export async function collectResparkableCrossSubjectData(
  viewer: ResparkableViewer
): Promise<ResparkableCrossSubjectData> {
  const clauses = [];
  if (viewer.userId) clauses.push({ granteeUserId: viewer.userId });
  if (viewer.email) clauses.push({ granteeEmail: viewer.email.toLowerCase() });

  // No identity at all is not a subject. An unfiltered `OR: []` would match
  // every grant in the installation, which is the one failure mode here worth
  // spending a branch on.
  if (clauses.length === 0 || !viewer.userId) {
    return { sharedWithMe: [], commentsIWrote: [] };
  }

  const [grants, comments] = await Promise.all([
    prisma.resparkableGrant.findMany({
      where: { OR: clauses },
      select: {
        entityType: true,
        entityId: true,
        role: true,
        includeTaskDetail: true,
        createdAt: true,
        acceptedAt: true,
        inviteSentAt: true,
        expiresAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.resparkableComment.findMany({
      where: { authorUserId: viewer.userId },
      select: {
        entityType: true,
        entityId: true,
        body: true,
        editedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  return {
    // An allowlisted `select` rather than an `omit`, unlike every owner-scoped
    // source in the tier. The inversion is the same one `repo/shared-view.ts`
    // makes and for the same reason: these rows belong to somebody else, so a
    // column added to `ResparkableGrant` next month must not reach a third
    // party's export bundle because nobody remembered to exclude it.
    sharedWithMe: grants.map((grant) => ({
      entityType: grant.entityType,
      entityId: grant.entityId,
      role: grant.role,
      includeTaskDetail: grant.includeTaskDetail,
      sharedAt: grant.createdAt,
      acceptedAt: grant.acceptedAt,
      invitedAt: grant.inviteSentAt,
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
    })),
    commentsIWrote: comments,
  };
}
