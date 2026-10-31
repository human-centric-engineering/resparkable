/**
 * Resparkable's owner classifications: which of this tier's user-linked models
 * are private to one person (§115 t-807).
 *
 * Core's owner layer refuses a narrowed caller's read of another member's rows
 * on the models it classifies `enforced`, and its coverage guard
 * (`tests/unit/lib/db/owner-classification.test.ts`) fails on any model in a
 * fork schema file that links to a user and that no tier has classified.
 *
 * Since Sunrise 0.16.0 the guard sees every table here, because it counts any
 * `String` column named `…UserId` as a user link. Apart from `TransferJob`,
 * all of them are `not-personal`, and that is a decision about the long term,
 * not a shortcut. Who may read a Resparkable row is decided by its workspace:
 * the owner of a personal space, the members of a group's, and anyone a grant
 * or share link names. The D5 split enforces that (`repo/**` owner queries,
 * `access/**` shared ones; see `.context/framework/resparkable/sharing.md`).
 * Core's owner layer knows one owner per row, so labelling these `personal`
 * would describe personal spaces and get groups and sharing wrong: switched
 * on, it would refuse a member's read of their group's rows and a grantee's
 * read of what was shared with them.
 *
 * What that gives up is core's data-layer net under a query that forgets its
 * `spaceId`. Getting it back needs a seam in Sunrise for a fork's own read
 * rule, asked for in `sunrise-asks.md`; until then the D5 split and its tests
 * are the only wall.
 *
 * Registered from `lib/app/owner-classification.ts`, never from
 * `initResparkable()`: this runs while the Prisma client is being built, in
 * whichever runtime builds it. Do not import `@/lib/db` here.
 */
import { registerAppOwnerClassification } from '@/lib/db/owner-classification';

/**
 * The reason shared by every table that hangs off a space and records only who
 * wrote the row. `createdByUserId` is attribution (SetNull on erasure, probe
 * B11), never the read rule.
 */
const SPACE_SCOPED =
  "Read by space, not by person: a personal space's owner, a group's members, or whoever a grant " +
  'or share link names (the D5 split). createdByUserId records who wrote the row, which in a ' +
  'group is not who may read it.';

/** Tables whose only user column is `createdByUserId`. */
const SPACE_SCOPED_MODELS = [
  'ResparkableArea',
  'ResparkableBoard',
  'ResparkableBoardCard',
  'ResparkableChecklistItem',
  'ResparkableCreditAccount',
  'ResparkableDocument',
  'ResparkableEmbedding',
  'ResparkableEntity',
  'ResparkableEvent',
  'ResparkableGoal',
  'ResparkableJob',
  'ResparkableLink',
  'ResparkableProject',
  'ResparkableReview',
  'ResparkableShareLink',
  'ResparkableTag',
  'ResparkableTaskTag',
  'ResparkableThought',
  'ResparkableTimeBlock',
] as const;

export function registerResparkableOwnerClassification(): void {
  registerAppOwnerClassification({
    tier: 'framework',
    models: {
      TransferJob: { kind: 'personal', owner: { column: 'userId' } },
      ...Object.fromEntries(
        SPACE_SCOPED_MODELS.map((model) => [
          model,
          { kind: 'not-personal', because: SPACE_SCOPED } as const,
        ])
      ),
      ResparkableSpace: {
        kind: 'not-personal',
        because:
          'The workspace itself, and the boundary every other table is read by. ownerUserId is set on ' +
          "a personal space and null on a group's, whose readers are its members.",
      },
      ResparkableTask: {
        kind: 'not-personal',
        because:
          `${SPACE_SCOPED} assignedToUserId is who the task is assigned to, a group member, ` +
          'and decides nothing about reading.',
      },
      ResparkableCreditLedgerEntry: {
        kind: 'not-personal',
        because:
          "The space's spend history, read through the space. memberUserId names whose group balance " +
          "an entry moved: the group's books, not that member's row.",
      },
      ResparkableGrant: {
        kind: 'not-personal',
        because:
          "The owner's record of who they shared an item with. granteeUserId is the person given " +
          'access, who reads the item through the grant, never this row as theirs.',
      },
      ResparkableComment: {
        kind: 'not-personal',
        because:
          'A comment on a shared item, read by everyone the item is shared with. authorUserId is who ' +
          'wrote it, and erasing them deletes it (probe B9).',
      },
      ResparkableGroup: {
        kind: 'not-personal',
        because:
          'A group, read through its membership. operationalPayerUserId names the admin who pays the ' +
          "group's running costs: a setting of the group's, not a row of that admin's.",
      },
      ResparkableGroupInvite: {
        kind: 'not-personal',
        because:
          "A group's pending invitation, read by its admins. invitedByUserId records who sent it.",
      },
      ResparkableGroupMember: {
        kind: 'not-personal',
        because:
          "A group's roster: decides who may read the group's space, and is read by its members and admins, not owner-scoped.",
      },
      ResparkableGroupAuditEntry: {
        kind: 'not-personal',
        because:
          "The group's admin record; actorUserId and subjectUserId record who acted and on whom, read by the group's admins.",
      },
    },
  });
}
