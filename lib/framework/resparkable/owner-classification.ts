/**
 * Resparkable's owner classifications: which of this tier's user-linked models
 * are private to one person (§115 t-807).
 *
 * Core's owner layer refuses a narrowed caller's read of another member's rows
 * on the models it classifies `enforced`, and its coverage guard
 * (`tests/unit/lib/db/owner-classification.test.ts`) fails on any model in a
 * fork schema file that links to a user and that no tier has classified.
 *
 * Only the models that guard can see are here. Most of this tier's tables
 * reach `user` through hand-written foreign keys on `ownerUserId` and are
 * confined by the D5 split instead (`repo/**` owner queries, `access/**`
 * shared ones; see `.context/framework/resparkable/sharing.md`). None is
 * `enforced` yet, so classifying them changes no query.
 *
 * Registered from `lib/app/owner-classification.ts`, never from
 * `initResparkable()`: this runs while the Prisma client is being built, in
 * whichever runtime builds it. Do not import `@/lib/db` here.
 */
import { registerAppOwnerClassification } from '@/lib/db/owner-classification';

export function registerResparkableOwnerClassification(): void {
  registerAppOwnerClassification({
    tier: 'framework',
    models: {
      TransferJob: { kind: 'personal', owner: { column: 'userId' } },
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
