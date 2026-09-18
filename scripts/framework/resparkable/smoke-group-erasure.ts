/**
 * Resparkable group erasure and export smoke (Release 9, phase 48).
 *
 * Proves against the **real** database what the unit tests can only assert
 * about call arguments. plan.md's test 13b, which it calls the single most
 * important assertion in the release:
 *
 *   Erase a member of a group: their memberships are gone, their
 *   `createdByUserId` values are null, the group's rows are all still there,
 *   and their email appears in no row anywhere.
 *
 * and 13d's two erasure cases: erasing the last admin promotes the
 * longest-standing remaining member, and erasing the last member deletes the
 * group and its whole space.
 *
 * Also proves the Art. 15 half before anybody is erased: the subject's export
 * contains the rows they wrote in the group, and none that anybody else wrote.
 * That depends on `createdByUserId` actually being written, which it was not
 * until phase 48, so this is the check that would have caught it.
 *
 * Everything the unit tests mock is real here: the FK cascades (B13), the
 * `SetNull` on `createdByUserId` (B11), the B12 CHECK, and the erasure hook
 * running inside `eraseUser`'s transaction. The hook is registered in this
 * process, so this does NOT prove anything about Sunrise ask #44 (a hook
 * registered at boot may be absent in the route realm).
 *
 * Skips cleanly (exit 0) when no database is reachable. Self-cleaning: creates
 * only `smoke-resparkable-grp-*` users and removes them, their group spaces and
 * their erasure receipts on every path.
 *
 * Run with:
 *   npm run framework:resparkable:smoke-group-erasure
 */

import { prisma } from '@/lib/db/client';
import { collectResparkableCrossSubjectData } from '@/lib/framework/resparkable/access/subject-export';
import { registerResparkableErasureHook } from '@/lib/framework/resparkable/privacy/erasure';
import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import * as tasks from '@/lib/framework/resparkable/repo/tasks';
import { createGroup } from '@/lib/framework/resparkable/services/membership';
import { eraseUser } from '@/lib/privacy/erase-user';

const stamp = Date.now();
const PREFIX = 'smoke-resparkable-grp';

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

async function makeUser(label: string): Promise<{ id: string; email: string }> {
  return prisma.user.create({
    data: { name: `${PREFIX} ${label}`, email: `${PREFIX}-${label}-${stamp}@example.com` },
    select: { id: true, email: true },
  });
}

async function join(groupId: string, userId: string, role: string, joinedAt: Date): Promise<void> {
  await prisma.resparkableGroupMember.create({ data: { groupId, userId, role, joinedAt } });
}

async function erase(user: { id: string; email: string }, receipts: string[]): Promise<void> {
  const result = await eraseUser({
    userId: user.id,
    userEmail: user.email,
    actorUserId: user.id,
    reason: 'self_service',
  });
  receipts.push(result.receiptId);
}

/**
 * The two columns in the tier that hold an address with no foreign key behind
 * it, which is where an erased person's email could survive. Core's own tables
 * are `scripts/smoke/erasure.ts`'s to check.
 */
async function emailAppearsInGroupTables(email: string): Promise<boolean> {
  const address = email.toLowerCase();
  const [invites, grants] = await Promise.all([
    prisma.resparkableGroupInvite.count({ where: { email: address } }),
    prisma.resparkableGrant.count({ where: { granteeEmail: address } }),
  ]);
  return invites + grants > 0;
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('framework:resparkable:smoke-group-erasure skipped: no database reachable.');
    return;
  }

  // In this process the hook registers into the same realm `eraseUser` reads.
  registerResparkableErasureHook();

  const users: string[] = [];
  const spaces: string[] = [];
  const receipts: string[] = [];

  try {
    const admin = await makeUser('admin');
    const writer = await makeUser('writer');
    const other = await makeUser('other');
    users.push(admin.id, writer.id, other.id);

    // ── A group with an admin, a writer and one more member ────────────────
    const founded = await createGroup(admin.id, { name: `${PREFIX} ${stamp}` });
    const groupId = founded.groupId;
    const spaceId = founded.group.spaceId;
    spaces.push(spaceId);

    await join(groupId, writer.id, 'member', new Date(Date.now() + 1_000));
    await join(groupId, other.id, 'member', new Date(Date.now() + 2_000));

    // The writer's invitation, accepted, still carrying their address.
    await prisma.resparkableGroupInvite.create({
      data: {
        groupId,
        email: writer.email.toLowerCase(),
        role: 'member',
        invitedByUserId: admin.id,
        inviteTokenHash: `${PREFIX}-hash-${stamp}`,
        acceptedAt: new Date(),
      },
    });

    const writerScope = spaceScopeFor({ spaceId, actorUserId: writer.id, role: 'member' });
    const otherScope = spaceScopeFor({ spaceId, actorUserId: other.id, role: 'member' });
    const written = await tasks.createTask(writerScope, { title: `${PREFIX} writer's task` });
    const othersTask = await tasks.createTask(otherScope, { title: `${PREFIX} other's task` });

    console.log('\nAuthorship (§23.5)');
    const stored = await prisma.resparkableTask.findUnique({ where: { id: written.id } });
    check(stored?.createdByUserId === writer.id, 'a row in a group space records who wrote it');

    console.log('\nArt. 15: what the writer wrote in the group');
    const exported = await collectResparkableCrossSubjectData({
      userId: writer.id,
      email: writer.email,
    });
    const entry = exported.groupContributions.find((group) => group.groupId === groupId);
    const exportedIds = (entry?.rows.tasks ?? []).map((row) => row.id);
    check(entry !== undefined, 'the export has an entry for the group');
    check(exportedIds.includes(written.id), 'it contains the task the writer created');
    check(!exportedIds.includes(othersTask.id), 'and not the task another member created');
    check(!JSON.stringify(entry).includes(spaceId), 'and never the group space key');

    console.log('\n13b: erase a member of a group');
    await erase(writer, receipts);
    check(
      (await prisma.resparkableGroupMember.count({ where: { userId: writer.id } })) === 0,
      'their memberships are gone'
    );
    const after = await prisma.resparkableTask.findUnique({ where: { id: written.id } });
    check(after !== null, "the group's row they wrote is still there");
    check(after?.createdByUserId === null, 'with its createdByUserId nulled');
    check(
      (await prisma.resparkableTask.count({ where: { spaceId } })) === 2,
      "all of the group's rows are still there"
    );
    check(
      !(await emailAppearsInGroupTables(writer.email)),
      'their email appears in no Resparkable address column'
    );
    check(
      (await prisma.resparkableSpace.findUnique({ where: { spaceId } })) !== null,
      'the group space is untouched'
    );

    console.log('\n13d: erase the last admin');
    await erase(admin, receipts);
    const promoted = await prisma.resparkableGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId: other.id } },
    });
    check(promoted?.role === 'admin', 'the longest-standing remaining member becomes admin');

    console.log('\n13d: erase the last member');
    await erase(other, receipts);
    check(
      (await prisma.resparkableGroup.findUnique({ where: { id: groupId } })) === null,
      'the group is deleted'
    );
    check(
      (await prisma.resparkableSpace.findUnique({ where: { spaceId } })) === null,
      'and its space'
    );
    check(
      (await prisma.resparkableTask.count({ where: { spaceId } })) === 0,
      'and everything in it'
    );

    console.log('\nframework:resparkable:smoke-group-erasure passed');
  } finally {
    // `deleteMany` rather than `delete`: on the passing path the erasures have
    // already removed every one of these, and a `delete` of a missing row is a
    // logged error on every successful run.
    await prisma.resparkableSpace
      .deleteMany({ where: { spaceId: { in: spaces } } })
      .catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
    if (receipts.length > 0) {
      await prisma.dataErasureReceipt
        .deleteMany({ where: { id: { in: receipts } } })
        .catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('framework:resparkable:smoke-group-erasure FAILED');
  console.error(error);
  process.exit(1);
});
