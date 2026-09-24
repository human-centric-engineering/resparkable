/**
 * Resparkable group sharing smoke (Release 9, phase 49).
 *
 * Proves against the **real** database what the unit tests can only assert
 * about call arguments. plan.md's two tests for this phase:
 *
 *   13f. With a group grantee the item is readable by every current member, a
 *   member added afterwards can read it, a member removed afterwards cannot,
 *   and revocation is immediate for all of them. A grant to a group puts
 *   **zero** rows in that group's `ResparkableEmbedding`, asserted by query
 *   inspection rather than by mocking.
 *
 *   13g. A member of three spaces gets three separate lists, three separate
 *   searches and three separate context blocks. A search returns rows from
 *   exactly one space per call, and the built context for a group turn contains
 *   no row from the actor's personal space.
 *
 * Every viewer is built the way a request builds one: membership resolved by
 * `resolveActiveSpaceScope`, then `viewerFor`. So "a member removed afterwards
 * cannot" is proved through the same check a route makes, not by handing the
 * resolver a viewer the database no longer agrees with.
 *
 * The search half runs on synthetic vectors written through the real repo, as
 * `smoke-search.ts`'s fallback does. What is under test is the scoped SQL, and
 * a smoke that called an embedding provider would bill somebody on every run
 * for an answer that does not depend on the model.
 *
 * Skips cleanly (exit 0) when no database is reachable. Self-cleaning: creates
 * only `smoke-resparkable-share-*` users and removes them, their group spaces
 * and everything in both on every path.
 *
 * Run with:
 *   npm run framework:resparkable:smoke-group-sharing
 */

import type { AuthSession } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import type { ResparkableViewer } from '@/lib/framework/resparkable/access/types';
import { viewerFor } from '@/lib/framework/resparkable/api/viewer';
import { loadResparkableContext } from '@/lib/framework/resparkable/context/contributor';
import {
  hybridSearchRows,
  RESPARKABLE_EMBEDDING_DIMENSION,
  upsertEmbeddings,
} from '@/lib/framework/resparkable/repo/embeddings';
import * as goals from '@/lib/framework/resparkable/repo/goals';
import * as projects from '@/lib/framework/resparkable/repo/projects';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { issueGrant, revokeGrant } from '@/lib/framework/resparkable/services/grants';
import {
  createGroup,
  resolveActiveSpaceScope,
} from '@/lib/framework/resparkable/services/membership';
import {
  listSharedWithMe,
  readSharedWithMe,
  searchSharedWithMe,
} from '@/lib/framework/resparkable/services/shared-with-me';
import { ensureResparkableSpace } from '@/lib/framework/resparkable/services/space';
import { createGrantSchema } from '@/lib/framework/resparkable/validations';

const stamp = Date.now();
const PREFIX = 'smoke-resparkable-share';

interface SmokeUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function makeUser(label: string): Promise<SmokeUser> {
  const user = await prisma.user.create({
    data: { name: `${PREFIX} ${label}`, email: `${PREFIX}-${label}-${stamp}@example.com` },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  await ensureResparkableSpace(user.id);
  return user;
}

async function join(groupId: string, userId: string, role: string): Promise<void> {
  await prisma.resparkableGroupMember.create({
    data: { groupId, userId, role, joinedAt: new Date() },
  });
}

/** The session a route would hand `viewerFor`. Only `user` is read. */
function sessionFor(user: SmokeUser): AuthSession {
  return {
    session: {
      id: `${PREFIX}-session-${user.id}`,
      userId: user.id,
      token: `${PREFIX}-token-${user.id}`,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    user,
  };
}

/**
 * A scope for this person in this workspace, resolved the way every request
 * resolves one. `null` for the personal workspace. Throws when membership says
 * no, because every caller here expects to be let in.
 */
async function scopeIn(user: SmokeUser, spaceId: string | null): Promise<SpaceScope> {
  const scope = await resolveActiveSpaceScope(user.id, spaceId);
  if (!scope) throw new Error(`${user.name} is not in ${spaceId ?? 'their personal space'}`);
  return scope;
}

/** The viewer a request from this workspace would carry, or `null` for a 404. */
async function viewerIn(
  user: SmokeUser,
  spaceId: string | null
): Promise<ResparkableViewer | null> {
  const scope = await resolveActiveSpaceScope(user.id, spaceId);
  return scope ? viewerFor(sessionFor(user), scope) : null;
}

/** Parsed by the route's own schema, so the input is exactly what a POST carries. */
function grantTo(
  entityId: string,
  grantee: { granteeEmail: string } | { granteeSpaceId: string },
  role: 'viewer' | 'commenter' = 'viewer'
) {
  return createGrantSchema.parse({
    entityType: 'project',
    entityId,
    role,
    expiry: { kind: 'never' },
    ...grantee,
  });
}

function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`expected ${what}`);
  return value;
}

async function canRead(viewer: ResparkableViewer | null, projectId: string): Promise<boolean> {
  if (!viewer) return false;
  const read = await readSharedWithMe(viewer, { entityType: 'project', entityId: projectId });
  return read !== null;
}

async function listedIds(viewer: ResparkableViewer | null): Promise<string[]> {
  if (!viewer) return [];
  return (await listSharedWithMe(viewer)).map((entry) => entry.item.id).sort();
}

/** A unit vector on one axis. Two rows on the same axis are an exact match. */
function unitVector(axis: number): number[] {
  const vector = new Array<number>(RESPARKABLE_EMBEDDING_DIMENSION).fill(0);
  vector[axis] = 1;
  return vector;
}

/** Written through the real repo, as the indexer would, with made-up numbers. */
async function seedVector(scope: SpaceScope, goalId: string, text: string): Promise<void> {
  await upsertEmbeddings(scope, [
    {
      entityType: 'goal',
      entityId: goalId,
      chunkIndex: 0,
      content: text,
      sensitivity: 'private',
      contentHash: `${PREFIX}-${goalId}`,
      // The same vector in every space, which is the hard case: each space's
      // row is an exact match for every space's query, so only the scope can
      // keep them apart.
      embedding: unitVector(0),
      embeddingModel: 'synthetic-smoke',
      embeddingProvider: 'synthetic',
      embeddingDimension: RESPARKABLE_EMBEDDING_DIMENSION,
      embeddedAt: new Date(),
    },
  ]);
}

async function searchIds(scope: SpaceScope, query: string): Promise<string[]> {
  const rows = await hybridSearchRows(scope, {
    embedding: unitVector(0),
    query,
    entityTypes: ['goal'],
    limit: 30,
    maxDistance: 0.8,
    excludeSensitive: false,
  });
  return rows.map((row) => row.entityId);
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('framework:resparkable:smoke-group-sharing skipped: no database reachable.');
    return;
  }

  const users: string[] = [];
  const spaces: string[] = [];

  try {
    const owner = await makeUser('owner');
    const member = await makeUser('member');
    const peer = await makeUser('peer');
    const reader = await makeUser('reader');
    const late = await makeUser('late');
    users.push(owner.id, member.id, peer.id, reader.id, late.id);

    // `member` is in three spaces: their own, Alpha and Beta. The owner is in
    // Alpha and Beta too, because sharing with a group means being in it.
    const alpha = await createGroup(member.id, { name: `${PREFIX} ${stamp} alpha` });
    const beta = await createGroup(member.id, { name: `${PREFIX} ${stamp} beta` });
    const source = await createGroup(owner.id, { name: `${PREFIX} ${stamp} source` });
    const ALPHA = alpha.group.spaceId;
    const BETA = beta.group.spaceId;
    const SOURCE = source.group.spaceId;
    spaces.push(ALPHA, BETA, SOURCE);

    await join(alpha.groupId, owner.id, 'member');
    await join(alpha.groupId, peer.id, 'member');
    await join(alpha.groupId, reader.id, 'viewer');
    await join(beta.groupId, owner.id, 'member');

    const ownerScope = await scopeIn(owner, null);
    const sourceScope = await scopeIn(owner, SOURCE);

    const toPerson = await projects.createProject(ownerScope, {
      name: `${PREFIX} to the member`,
      slug: `to-member-${stamp}`,
    });
    const toAlpha = await projects.createProject(ownerScope, {
      name: `${PREFIX} to Alpha`,
      slug: `to-alpha-${stamp}`,
    });
    const groupToAlpha = await projects.createProject(sourceScope, {
      name: `${PREFIX} from Source to Alpha`,
      slug: `source-to-alpha-${stamp}`,
    });
    const toBeta = await projects.createProject(ownerScope, {
      name: `${PREFIX} to Beta`,
      slug: `to-beta-${stamp}`,
    });
    const shared = [toPerson.id, toAlpha.id, groupToAlpha.id, toBeta.id];

    const embeddingsIn = (spaceId: string): Promise<number> =>
      prisma.resparkableEmbedding.count({ where: { spaceId } });
    const alphaEmbeddingsBefore = await embeddingsIn(ALPHA);

    console.log('\nIssuing grants');
    const personGrant = await issueGrant(
      ownerScope,
      grantTo(toPerson.id, { granteeEmail: member.email })
    );
    const alphaGrant = await issueGrant(
      ownerScope,
      grantTo(toAlpha.id, { granteeSpaceId: ALPHA }, 'commenter')
    );
    const sourceGrant = await issueGrant(
      sourceScope,
      grantTo(groupToAlpha.id, { granteeSpaceId: ALPHA })
    );
    const betaGrant = await issueGrant(ownerScope, grantTo(toBeta.id, { granteeSpaceId: BETA }));
    check(
      personGrant !== null && alphaGrant !== null && sourceGrant !== null && betaGrant !== null,
      'a person, two groups, and a group sharing with a group are all accepted'
    );
    check(
      alphaGrant?.granteeGroup?.memberCount === 4,
      "the owner's summary names Alpha with its four joined members"
    );

    const strangers = await createGroup(late.id, { name: `${PREFIX} ${stamp} strangers` });
    spaces.push(strangers.group.spaceId);
    const refused = await issueGrant(
      ownerScope,
      grantTo(toAlpha.id, { granteeSpaceId: strangers.group.spaceId })
    );
    check(refused === null, 'a group the owner is not in cannot be granted anything');

    console.log('\n13f: every current member can read a group grant');
    check(await canRead(await viewerIn(member, ALPHA), toAlpha.id), 'the admin, inside Alpha');
    check(await canRead(await viewerIn(peer, ALPHA), toAlpha.id), 'a member, inside Alpha');
    check(await canRead(await viewerIn(reader, ALPHA), toAlpha.id), 'and a viewer, inside Alpha');

    const asMember = await readSharedWithMe(required(await viewerIn(member, ALPHA), 'a viewer'), {
      entityType: 'project',
      entityId: toAlpha.id,
    });
    const asReader = await readSharedWithMe(required(await viewerIn(reader, ALPHA), 'a viewer'), {
      entityType: 'project',
      entityId: toAlpha.id,
    });
    check(
      asMember?.access.ok === true && asMember.access.permissions.comment,
      'a writer can comment under a commenter grant'
    );
    check(
      asReader?.access.ok === true && !asReader.access.permissions.comment,
      "a group viewer cannot, because a comment is a write in the group's name"
    );

    const fromSource = await readSharedWithMe(required(await viewerIn(peer, ALPHA), 'a viewer'), {
      entityType: 'project',
      entityId: groupToAlpha.id,
    });
    check(
      fromSource?.owner.kind === 'group' && fromSource.owner.name === source.group.name,
      'a group-to-group share names the sharing group, not a person'
    );

    console.log('\n13f: a member added afterwards can read it');
    check(!(await canRead(await viewerIn(late, ALPHA), toAlpha.id)), 'not before they join');
    await join(alpha.groupId, late.id, 'member');
    check(
      await canRead(await viewerIn(late, ALPHA), toAlpha.id),
      'and on their next request after'
    );

    console.log('\n13f: a member removed afterwards cannot');
    await prisma.resparkableGroupMember.delete({
      where: { groupId_userId: { groupId: alpha.groupId, userId: peer.id } },
    });
    check((await viewerIn(peer, ALPHA)) === null, 'Alpha is a 404 to them now');
    check(
      !(await canRead(await viewerIn(peer, null), toAlpha.id)),
      'and the grant does not follow them into their personal space'
    );

    console.log('\n13f: revocation is immediate for everyone');
    const revoked = await revokeGrant(ownerScope, required(alphaGrant, 'the Alpha grant').id);
    check(revoked !== null, 'the owner revokes the Alpha grant');
    for (const person of [member, reader, late]) {
      check(
        !(await canRead(await viewerIn(person, ALPHA), toAlpha.id)),
        `${person.name} can no longer read it`
      );
    }
    check(
      await canRead(await viewerIn(member, ALPHA), groupToAlpha.id),
      "Source's separate grant to Alpha is untouched"
    );

    console.log("\n13f: a group grant puts nothing in the group's embeddings");
    // Reads and a search have run through Alpha by now, so this also proves
    // nothing on the read path indexes what it was shown.
    await searchSharedWithMe(required(await viewerIn(member, ALPHA), 'a viewer'), { q: PREFIX });
    check(
      (await embeddingsIn(ALPHA)) === alphaEmbeddingsBefore && alphaEmbeddingsBefore === 0,
      "Alpha's ResparkableEmbedding has zero rows"
    );
    const leaked = await prisma.resparkableEmbedding.count({
      where: { entityId: { in: shared }, spaceId: { notIn: [owner.id, SOURCE] } },
    });
    check(leaked === 0, 'no space but the owning one has an embedding for any shared item');

    console.log('\n13g: three spaces, three separate lists');
    const personalView = await viewerIn(member, null);
    const alphaView = await viewerIn(member, ALPHA);
    const betaView = await viewerIn(member, BETA);
    check(
      JSON.stringify(await listedIds(personalView)) === JSON.stringify([toPerson.id]),
      'personal: only what was shared with them as a person'
    );
    check(
      JSON.stringify(await listedIds(alphaView)) === JSON.stringify([groupToAlpha.id]),
      'Alpha: only what is still shared with Alpha'
    );
    check(
      JSON.stringify(await listedIds(betaView)) === JSON.stringify([toBeta.id]),
      'Beta: only what was shared with Beta'
    );
    check(
      !(await canRead(personalView, toBeta.id)) && !(await canRead(alphaView, toPerson.id)),
      "and opening another space's item by id is refused, not just unlisted"
    );

    console.log('\n13g: three separate shared searches');
    const found = async (viewer: ResparkableViewer | null): Promise<string[]> =>
      viewer
        ? (await searchSharedWithMe(viewer, { q: PREFIX })).items.map((hit) => hit.item.id).sort()
        : [];
    check(
      JSON.stringify(await found(personalView)) === JSON.stringify([toPerson.id]),
      'personal search finds only the personal share'
    );
    check(
      JSON.stringify(await found(alphaView)) === JSON.stringify([groupToAlpha.id]),
      "Alpha's search finds only Alpha's live share"
    );
    check(
      JSON.stringify(await found(betaView)) === JSON.stringify([toBeta.id]),
      "Beta's search finds only Beta's share"
    );

    console.log('\n13g: three separate brains to search');
    const memberPersonal = await scopeIn(member, null);
    const memberAlpha = await scopeIn(member, ALPHA);
    const memberBeta = await scopeIn(member, BETA);
    const personalGoal = await goals.createGoal(memberPersonal, {
      title: `${PREFIX} personal goal`,
      slug: `personal-goal-${stamp}`,
      horizon: 'quarter',
    });
    const alphaGoal = await goals.createGoal(memberAlpha, {
      title: `${PREFIX} alpha goal`,
      slug: `alpha-goal-${stamp}`,
      horizon: 'quarter',
    });
    const betaGoal = await goals.createGoal(memberBeta, {
      title: `${PREFIX} beta goal`,
      slug: `beta-goal-${stamp}`,
      horizon: 'quarter',
    });
    await seedVector(memberPersonal, personalGoal.id, personalGoal.title);
    await seedVector(memberAlpha, alphaGoal.id, alphaGoal.title);
    await seedVector(memberBeta, betaGoal.id, betaGoal.title);

    for (const [label, scope, goalId] of [
      ['personal', memberPersonal, personalGoal.id],
      ['Alpha', memberAlpha, alphaGoal.id],
      ['Beta', memberBeta, betaGoal.id],
    ] as const) {
      const ids = await searchIds(scope, `${PREFIX} goal`);
      check(
        ids.length === 1 && ids[0] === goalId,
        `the ${label} search returns its own row and none of the other two identical matches`
      );
    }

    console.log('\n13g: three separate context blocks');
    const personalContext = await loadResparkableContext('', { userId: member.id });
    const alphaContext = await loadResparkableContext(ALPHA, { userId: member.id });
    const betaContext = await loadResparkableContext(BETA, { userId: member.id });
    check(
      personalContext.includes(personalGoal.title) &&
        alphaContext.includes(alphaGoal.title) &&
        betaContext.includes(betaGoal.title),
      "each block carries its own space's goal"
    );
    check(
      !alphaContext.includes(personalGoal.title) && !betaContext.includes(personalGoal.title),
      "a group turn's context has no row from the member's personal space"
    );
    check(
      !alphaContext.includes(betaGoal.title) && !betaContext.includes(alphaGoal.title),
      'and neither group sees the other'
    );
    check(
      !alphaContext.includes(groupToAlpha.name) && !personalContext.includes(toPerson.name),
      "shared-in items stay out of the recipient's context"
    );

    console.log('\nframework:resparkable:smoke-group-sharing passed');
  } finally {
    // Group spaces first: a user delete cascades their personal space, but a
    // group's space is not theirs and would be left behind.
    await prisma.resparkableSpace
      .deleteMany({ where: { spaceId: { in: spaces } } })
      .catch(() => undefined);
    await prisma.resparkableSpace
      .deleteMany({ where: { spaceId: { in: users } } })
      .catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('framework:resparkable:smoke-group-sharing FAILED');
  console.error(error);
  process.exit(1);
});
