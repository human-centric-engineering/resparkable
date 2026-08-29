/**
 * Space repo — the one table keyed by `userId` rather than scoped by it.
 *
 * `ResparkableSpace` is where a scope *comes from*, so its reads take a plain
 * verified `userId` instead of an `OwnerScope`: `ensureResparkableSpace()` runs
 * before there is a space to scope to. That is the single exception to the D5
 * signature rule, and it is why this file is short enough to audit at a glance.
 *
 * Lookup by `inboxToken` is the inbound-email entry point — the one place a
 * user id is *derived* from an attacker-supplied value rather than a session,
 * which is why the token is a 16-byte bearer credential and why the adapter
 * must still verify the sender (§17 risk 8).
 */

import { prisma } from '@/lib/db/client';
import { Prisma, type ResparkableSpace } from '@prisma/client';

export async function findSpaceByUserId(userId: string): Promise<ResparkableSpace | null> {
  return prisma.resparkableSpace.findUnique({ where: { userId } });
}

export async function findSpaceByToken(inboxToken: string): Promise<ResparkableSpace | null> {
  return prisma.resparkableSpace.findUnique({ where: { inboxToken } });
}

/**
 * Mint a personal space.
 *
 * The three phase-45 columns are written HERE rather than defaulted in the
 * schema, and the reason is worth stating because the alternative looks
 * cheaper. `ownerUserId` cannot have a default: it has to equal the key, and
 * Postgres cannot default one column from another without a trigger or a
 * generated column, and a generated column would be actively wrong the moment
 * a group space exists, because a group space's `ownerUserId` is deliberately
 * NULL (§23.2).
 *
 * Getting this wrong is silent and severe, which is how it was caught: the
 * migration backfills every space that already existed, so the drift probe and
 * the whole unit suite stayed green while every space created AFTERWARDS had a
 * null `ownerUserId` and was therefore unreachable by the erasure cascade.
 * `npm run framework:resparkable:smoke-isolation` found it, against a real
 * database, which is precisely the class of bug that smoke exists for.
 *
 * `kind` and `isDefault` both have real schema defaults and are still written
 * explicitly: this function is the one place a personal space comes into
 * existence, and a reader should be able to see what one is without going to
 * the schema for two thirds of the answer.
 */
export async function createSpace(data: {
  userId: string;
  inboxToken: string;
}): Promise<ResparkableSpace> {
  return prisma.resparkableSpace.create({
    data: {
      ...data,
      // A personal space's key value IS its owner's user id (§23.2). This is
      // the invariant the whole rename rests on, and the only place it is
      // established rather than assumed.
      ownerUserId: data.userId,
      kind: 'personal',
      // Every owner has exactly one workspace until Release 10, and §24.2 is
      // explicit that a user may not have none. The partial unique index
      // (probe B10) is what stops a second one appearing.
      isDefault: true,
    },
  });
}

/** The settings patch in domain terms — `null` means "reset me to the defaults". */
export interface SpaceSettingsPatch {
  timezone?: string;
  workStyle?: string;
  priorityWeights?: object | null;
  energyProfile?: object | null;
  retentionPolicy?: object | null;
  /**
   * Nullable scalar, not a `Json` column — so a plain `null` reaches SQL as NULL
   * and needs none of the `Prisma.DbNull` translation below. `null` means "use
   * the code default" (`STRENGTH_FLOOR`), matching the migration's reasoning.
   */
  connectionStrengthFloor?: number | null;
}

/**
 * Update the settings columns, translating `null` into a real SQL NULL.
 *
 * Prisma will not accept a bare `null` for a nullable `Json` column: it demands
 * `Prisma.DbNull` (the column is NULL) or `Prisma.JsonNull` (the column holds
 * the JSON value `null`) — a distinction that only exists because JSON has its
 * own null. `DbNull` is the one we want, and it is the difference between
 * `customised: false` and `customised: true` on the settings payload.
 *
 * The translation lives here because `Prisma.DbNull` is a runtime value, and the
 * tier's lint boundary allows the Prisma client only inside `repo/**`. A service
 * would have to import it to express the same thing.
 */
export async function updateSpaceSettings(
  userId: string,
  patch: SpaceSettingsPatch
): Promise<ResparkableSpace> {
  const data: Prisma.ResparkableSpaceUncheckedUpdateInput = {};

  if (patch.timezone !== undefined) data.timezone = patch.timezone;
  if (patch.workStyle !== undefined) data.workStyle = patch.workStyle;
  if (patch.priorityWeights !== undefined) data.priorityWeights = jsonOrNull(patch.priorityWeights);
  if (patch.energyProfile !== undefined) data.energyProfile = jsonOrNull(patch.energyProfile);
  if (patch.retentionPolicy !== undefined) data.retentionPolicy = jsonOrNull(patch.retentionPolicy);
  if (patch.connectionStrengthFloor !== undefined) {
    data.connectionStrengthFloor = patch.connectionStrengthFloor;
  }

  return prisma.resparkableSpace.update({ where: { userId }, data });
}

function jsonOrNull(value: object | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : value;
}
