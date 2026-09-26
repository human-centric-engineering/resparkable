/**
 * Resparkable group join-link smoke (Release 9, phase 57).
 *
 * Proves against the **real** database what the unit tests can only assert
 * about call arguments. plan.md's test 13i:
 *
 *   A link expires, revokes, and stops at `maxUses`; a redeemed link cannot be
 *   redeemed twice by the same account; no link can confer `admin`; a `request`
 *   link produces a membership row that resolves to no scope at all. A group at
 *   `maxMembers` refuses the join with a message rather than accepting it and
 *   dropping it.
 *
 * Plus the two things only Postgres can show: the use-count compare-and-set and
 * the group row lock actually hold when redemptions race, so a full group and a
 * nearly used-up link are never overrun; and removing a pending request from a
 * group whose only joined member is the admin leaves the group standing (the
 * bug phase 57 fixed in `removeMember`).
 *
 * The services are called directly, so the rate limits are not exercised here;
 * those are the middleware's and are unit-tested.
 *
 * Skips cleanly (exit 0) when no database is reachable. Self-cleaning: creates
 * only `smoke-resparkable-join-*` users and removes them and their groups'
 * spaces on every path.
 *
 * Run with:
 *   npm run framework:resparkable:smoke-group-join
 */

import { prisma } from '@/lib/db/client';
import { hashShareToken } from '@/lib/framework/resparkable/access/resolve';
import { upsertInvite } from '@/lib/framework/resparkable/repo/groups';
import { acceptGroupInvite } from '@/lib/framework/resparkable/services/group-invites';
import {
  approveGroupJoinRequest,
  mintJoinLink,
  redeemJoinLinkToken,
  rejectGroupJoinRequest,
  revokeGroupJoinLink,
} from '@/lib/framework/resparkable/services/group-join-links';
import {
  createGroup,
  removeMember,
  resolveGroupMembership,
  resolveGroupSpaceScope,
  updateGroupSettings,
} from '@/lib/framework/resparkable/services/membership';
import type { CreateJoinLinkInput } from '@/lib/framework/resparkable/validations';

const stamp = Date.now();
const PREFIX = 'smoke-resparkable-join';

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

const users: string[] = [];
const spaces: string[] = [];

async function makeUser(label: string): Promise<string> {
  const user = await prisma.user.create({
    data: { name: `${PREFIX} ${label}`, email: `${PREFIX}-${label}-${stamp}@example.com` },
    select: { id: true },
  });
  users.push(user.id);
  return user.id;
}

function link(overrides: Partial<CreateJoinLinkInput> = {}): CreateJoinLinkInput {
  return { role: 'member', expiry: { kind: 'days', days: 30 }, ...overrides };
}

async function mint(adminId: string, groupId: string, input: CreateJoinLinkInput) {
  const minted = await mintJoinLink(adminId, groupId, input);
  if (!minted.ok) throw new Error(`mint refused: ${minted.reason}`);
  return minted;
}

async function outcome(userId: string, token: string): Promise<string> {
  const result = await redeemJoinLinkToken(userId, token);
  return result.ok ? result.outcome : result.reason;
}

async function usesSpent(linkId: string): Promise<number> {
  const row = await prisma.resparkableGroupJoinLink.findUnique({ where: { id: linkId } });
  return row?.useCount ?? -1;
}

async function joinedCount(groupId: string): Promise<number> {
  return prisma.resparkableGroupMember.count({ where: { groupId, joinedAt: { not: null } } });
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('framework:resparkable:smoke-group-join skipped: no database reachable');
    return;
  }

  try {
    const admin = await makeUser('admin');
    const created = await createGroup(admin, { name: `${PREFIX} ${stamp}` });
    const groupId = created.groupId;
    const spaceId = created.group.spaceId;
    spaces.push(spaceId);

    console.log('\nNo link confers admin');
    const adminLink = await mintJoinLink(admin, groupId, {
      ...link(),
      role: 'admin',
    } as unknown as CreateJoinLinkInput);
    check(!adminLink.ok && adminLink.reason === 'admin_link', 'the service refuses an admin link');
    check(
      (await prisma.resparkableGroupJoinLink.count({ where: { groupId } })) === 0,
      'and writes nothing'
    );

    console.log('\nAn open link stops at maxUses, and counts one use per person');
    const a = await makeUser('a');
    const b = await makeUser('b');
    const c = await makeUser('c');
    const capped = await mint(admin, groupId, link({ approval: 'open', maxUses: 2 }));
    check(
      (await prisma.resparkableGroupJoinLink.findUnique({ where: { id: capped.link.id } }))
        ?.tokenHash !== capped.token,
      'the token is not what is stored'
    );
    check((await outcome(a, capped.token)) === 'joined', 'the first person joins');
    check((await outcome(a, capped.token)) === 'already_member', 'redeeming again says so');
    check((await usesSpent(capped.link.id)) === 1, 'and spends no second use');
    check((await outcome(b, capped.token)) === 'joined', 'the second person joins');
    check(
      (await outcome(c, capped.token)) === 'unknown',
      'the third is refused: the link is used up'
    );
    check(
      (await resolveGroupSpaceScope(a, spaceId))?.role === 'member',
      'a joined member resolves to a member scope'
    );

    console.log('\nRevoked and expired links are refused');
    const revoked = await mint(admin, groupId, link({ approval: 'open' }));
    await revokeGroupJoinLink(admin, groupId, revoked.link.id);
    check((await outcome(c, revoked.token)) === 'unknown', 'a revoked link is refused');
    const expired = await mint(admin, groupId, link({ approval: 'open' }));
    await prisma.resparkableGroupJoinLink.update({
      where: { id: expired.link.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    check((await outcome(c, expired.token)) === 'unknown', 'an expired link is refused');
    check(
      (await outcome(c, 'x'.repeat(32))) === 'unknown',
      'a token nobody minted gets the same answer'
    );

    console.log('\nA request link writes a row that resolves to nothing');
    const request = await mint(admin, groupId, link());
    check(request.link.approval === 'request', 'a member link defaults to needing approval');
    check((await outcome(c, request.token)) === 'requested', 'redeeming it files a request');
    check((await resolveGroupSpaceScope(c, spaceId)) === null, 'the pending member has no scope');
    check((await resolveGroupMembership(c, groupId)) === null, 'and no membership either');
    check((await outcome(c, request.token)) === 'already_requested', 'asking twice says so');
    check((await usesSpent(request.link.id)) === 1, 'and spends one use, not two');
    const rejected = await rejectGroupJoinRequest(admin, groupId, c);
    check(rejected.ok, 'the admin can turn the request down');
    check(
      (await prisma.resparkableGroupMember.findUnique({
        where: { groupId_userId: { groupId, userId: c } },
      })) === null,
      'and nothing is left behind'
    );

    console.log('\nA full group refuses and tells the admin');
    await updateGroupSettings(admin, groupId, { maxMembers: await joinedCount(groupId) });
    const open = await mint(admin, groupId, link({ approval: 'open' }));
    const refused = await redeemJoinLinkToken(c, open.token);
    check(!refused.ok && refused.reason === 'group_full', 'the join is refused, not dropped');
    check(
      (await prisma.resparkableGroup.findUnique({ where: { id: groupId } }))?.joinRefusedFullAt !==
        null,
      'the group records that somebody was turned away'
    );
    check((await usesSpent(open.link.id)) === 0, 'and the refused join spent no use');

    console.log('\nConcurrent joins cannot overrun the cap');
    await updateGroupSettings(admin, groupId, { maxMembers: (await joinedCount(groupId)) + 2 });
    check(
      (await prisma.resparkableGroup.findUnique({ where: { id: groupId } }))?.joinRefusedFullAt ===
        null,
      'changing the cap clears the notice'
    );
    const racers = await Promise.all(
      Array.from({ length: 6 }, (_, index) => makeUser(`race-${index}`))
    );
    const results = await Promise.all(racers.map((userId) => outcome(userId, open.token)));
    check(results.filter((r) => r === 'joined').length === 2, 'exactly two of six get in');
    check(results.filter((r) => r === 'group_full').length === 4, 'the other four are told why');
    check((await usesSpent(open.link.id)) === 2, 'and exactly two uses were spent');

    console.log('\nConcurrent redemptions cannot overrun maxUses');
    await updateGroupSettings(admin, groupId, { maxMembers: 500 });
    const lastUse = await mint(admin, groupId, link({ approval: 'open', maxUses: 1 }));
    const pair = await Promise.all([makeUser('pair-1'), makeUser('pair-2')]);
    const pairResults = await Promise.all(pair.map((userId) => outcome(userId, lastUse.token)));
    check(pairResults.filter((r) => r === 'joined').length === 1, 'one of two racing people joins');
    check((await usesSpent(lastUse.link.id)) === 1, 'and the link is used exactly once');

    console.log('\nApproval is held to the cap too');
    const waiting = await makeUser('waiting');
    check((await outcome(waiting, request.token)) === 'requested', 'somebody asks to join');
    await updateGroupSettings(admin, groupId, { maxMembers: await joinedCount(groupId) });
    const full = await approveGroupJoinRequest(admin, groupId, waiting);
    check(!full.ok && full.reason === 'group_full', 'approving into a full group is refused');
    await updateGroupSettings(admin, groupId, { maxMembers: 500 });
    check((await approveGroupJoinRequest(admin, groupId, waiting)).ok, 'with room, it succeeds');
    check(
      (await resolveGroupSpaceScope(waiting, spaceId))?.role === 'member',
      'and they now resolve to a member scope'
    );

    console.log('\nRemoving a request never deletes the group');
    const lone = await createGroup(admin, { name: `${PREFIX} lone ${stamp}` });
    spaces.push(lone.group.spaceId);
    const loneLink = await mint(admin, lone.groupId, link());
    const asker = await makeUser('asker');
    check((await outcome(asker, loneLink.token)) === 'requested', 'somebody asks to join');
    const removed = await removeMember(admin, lone.groupId, asker);
    check(removed.ok && !removed.value.groupDeleted, 'the admin removes the request');
    check(
      (await prisma.resparkableGroup.findUnique({ where: { id: lone.groupId } })) !== null,
      'and the group, whose only joined member is the admin, is still there'
    );
    check((await outcome(asker, loneLink.token)) === 'requested', 'they can ask again');
    const withdrawn = await removeMember(asker, lone.groupId, asker);
    check(withdrawn.ok, 'and can withdraw their own request');

    console.log('\nTurning somebody down gives their place on the link back');
    const onePlace = await mint(admin, groupId, link({ maxUses: 1 }));
    const stranger = await makeUser('stranger');
    const colleague = await makeUser('colleague');
    check((await outcome(stranger, onePlace.token)) === 'requested', 'a stranger asks to join');
    check((await usesSpent(onePlace.link.id)) === 1, 'which uses the only place on the link');
    check((await rejectGroupJoinRequest(admin, groupId, stranger)).ok, 'the admin turns them down');
    check((await usesSpent(onePlace.link.id)) === 0, 'and the place is free again');
    check((await outcome(colleague, onePlace.token)) === 'requested', 'so the colleague can ask');
    check((await removeMember(colleague, groupId, colleague)).ok, 'withdrawing a request');
    check((await usesSpent(onePlace.link.id)) === 0, 'also frees the place');

    console.log('\nSomebody waiting is let in by an instant link, at its role');
    const waiter = await makeUser('waiter');
    const asMember = await mint(admin, groupId, link({ role: 'member' }));
    check((await outcome(waiter, asMember.token)) === 'requested', 'they ask to join as a member');
    const instantViewer = await mint(admin, groupId, link({ role: 'viewer', approval: 'open' }));
    check(
      (await outcome(waiter, instantViewer.token)) === 'joined',
      'an instant link lets them in'
    );
    check(
      (await resolveGroupSpaceScope(waiter, spaceId))?.role === 'viewer',
      'at the instant link’s role'
    );
    check((await usesSpent(asMember.link.id)) === 1, 'and the first link’s use stays spent');

    console.log('\nSomebody waiting who accepts an invitation gets the invitation’s role');
    const invitee = await makeUser('invitee');
    const inviteeEmail = `${PREFIX}-invitee-${stamp}@example.com`;
    const asViewer = await mint(admin, groupId, link({ role: 'viewer', approval: 'request' }));
    check((await outcome(invitee, asViewer.token)) === 'requested', 'they ask to join as a viewer');
    const inviteToken = 'i'.repeat(32);
    await upsertInvite({
      groupId,
      email: inviteeEmail,
      role: 'member',
      invitedByUserId: admin,
      inviteTokenHash: hashShareToken(inviteToken),
      expiresAt: null,
    });
    const accepted = await acceptGroupInvite({ userId: invitee, email: inviteeEmail }, inviteToken);
    check(accepted.ok, 'then accept an invitation as a member');
    check(
      (await resolveGroupSpaceScope(invitee, spaceId))?.role === 'member',
      'and are let in as a member, not a viewer'
    );

    console.log('\nframework:resparkable:smoke-group-join passed');
  } finally {
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
  console.error('framework:resparkable:smoke-group-join FAILED');
  console.error(error);
  process.exit(1);
});
