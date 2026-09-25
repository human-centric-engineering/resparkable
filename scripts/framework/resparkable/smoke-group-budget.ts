/**
 * Resparkable group budget and digest smoke (Release 9, phase 50).
 *
 * Proves against the **real** database what the unit tests can only assert
 * about call arguments: the top-up transaction, its refusal to overdraw, the
 * conditional cap update, the per-member ledger summary, the pre-flight's
 * refusals, the demand gate's query, and the digest's gather and guard.
 *
 * No model is called and nothing is billed to a provider: spend is recorded
 * through `recordAgentSpend` with a made-up cost, which is the same write the
 * chat route and the billing pass make after a real run.
 *
 * Skips cleanly (exit 0) when no database is reachable. Self-cleaning: creates
 * only `smoke-resparkable-budget-*` users and removes them, their group space
 * and everything in both on every path.
 *
 * Run with:
 *   npm run framework:resparkable:smoke-group-budget
 */

import { prisma } from '@/lib/db/client';
import { jobKindsForSpace } from '@/lib/framework/resparkable/queue/kinds';
import { hasResparkableActivitySince } from '@/lib/framework/resparkable/repo/jobs';
import { backgroundSpaceScope, spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { assertCanSpend, recordAgentSpend } from '@/lib/framework/resparkable/services/billing';
import { captureThought } from '@/lib/framework/resparkable/services/capture';
import {
  getGroupBudget,
  notifyGroupBudgetThresholds,
  setMemberDailyCreditCap,
  topUpGroup,
  updateGroupBudgetSettings,
} from '@/lib/framework/resparkable/services/group-budget';
import {
  buildGroupDigestInputs,
  getLatestGroupDigest,
} from '@/lib/framework/resparkable/services/group-digest';
import {
  createGroup,
  resolveGroupMembership,
} from '@/lib/framework/resparkable/services/membership';
import { writeReview } from '@/lib/framework/resparkable/services/reviews';
import { ensureResparkableSpace } from '@/lib/framework/resparkable/services/space';

const stamp = Date.now();
const PREFIX = 'smoke-resparkable-budget';

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

async function refused(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}

async function makeUser(label: string, balance: number): Promise<{ id: string; name: string }> {
  const user = await prisma.user.create({
    data: { name: `${PREFIX} ${label}`, email: `${PREFIX}-${label}-${stamp}@example.com` },
    select: { id: true, name: true },
  });
  await ensureResparkableSpace(user.id);
  await prisma.resparkableCreditAccount.upsert({
    where: { spaceId: user.id },
    create: { spaceId: user.id, balanceCredits: balance },
    update: { balanceCredits: balance },
  });
  return user;
}

async function balanceOf(spaceId: string): Promise<number> {
  const account = await prisma.resparkableCreditAccount.findUnique({ where: { spaceId } });
  return account?.balanceCredits ?? 0;
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('framework:resparkable:smoke-group-budget skipped: no database');
    return;
  }

  const users: string[] = [];
  const spaces: string[] = [];

  try {
    const admin = await makeUser('admin', 100);
    const member = await makeUser('member', 50);
    const viewer = await makeUser('viewer', 50);
    users.push(admin.id, member.id, viewer.id);

    const created = await createGroup(admin.id, { name: `${PREFIX} ${stamp}` });
    const groupId = created.groupId;
    const SPACE = created.group.spaceId;
    spaces.push(SPACE);
    for (const [user, role] of [
      [member, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      await prisma.resparkableGroupMember.create({
        data: { groupId, userId: user.id, role, joinedAt: new Date() },
      });
    }

    const scopeOf = async (userId: string) => {
      const resolved = await resolveGroupMembership(userId, groupId);
      if (!resolved) throw new Error(`${userId} is not in the group`);
      return resolved.scope;
    };

    console.log('\nthe group is owed group jobs, and one digest');
    const jobKinds = (
      await prisma.resparkableJob.findMany({ where: { spaceId: SPACE }, select: { kind: true } })
    )
      .map((job) => job.kind)
      .sort();
    check(
      JSON.stringify(jobKinds) === JSON.stringify([...jobKindsForSpace('group')].sort()),
      `the group space holds exactly ${jobKinds.join(', ')}`
    );

    console.log('\ntop-up: who may, and never an overdraft');
    const memberSelfFunded = await topUpGroup(member.id, groupId, 5);
    check(
      !memberSelfFunded.ok && memberSelfFunded.reason === 'top_up_not_allowed',
      'a member cannot top up a self-funded group'
    );
    const adminTopUp = await topUpGroup(admin.id, groupId, 40);
    check(adminTopUp.ok && adminTopUp.value.balanceCredits === 40, 'an admin adds 40');
    check((await balanceOf(admin.id)) === 60, "and it came out of the admin's own 100");
    const tooMuch = await topUpGroup(admin.id, groupId, 1000);
    check(
      !tooMuch.ok && tooMuch.reason === 'insufficient_personal_credits',
      'more than they have is refused'
    );
    check(
      (await balanceOf(admin.id)) === 60 && (await balanceOf(SPACE)) === 40,
      'and the refused top-up moved nothing'
    );
    const rows = await prisma.resparkableCreditLedgerEntry.findMany({
      where: { kind: { in: ['transfer_out', 'transfer_in'] }, spaceId: { in: [admin.id, SPACE] } },
    });
    check(
      rows.length === 2 && rows.every((row) => row.createdByUserId === admin.id),
      'one transfer_out and one transfer_in, both attributed to the giver'
    );

    await updateGroupBudgetSettings(admin.id, groupId, { fundingMode: 'member_contributions' });
    const memberGives = await topUpGroup(member.id, groupId, 10);
    check(memberGives.ok && memberGives.value.balanceCredits === 50, 'a member may once it is on');
    const viewerGives = await topUpGroup(viewer.id, groupId, 10);
    check(!viewerGives.ok, 'a viewer never may');

    console.log('\nthe pre-flight: one account, a cap, and a viewer at zero');
    const memberScope = await scopeOf(member.id);
    const viewerScope = await scopeOf(viewer.id);
    check(
      (await refused(() => assertCanSpend(viewerScope))) === 'ForbiddenError',
      'a viewer is refused with the group in credit'
    );
    const capped = await setMemberDailyCreditCap(admin.id, groupId, member.id, 0.5);
    check(capped.ok, 'an admin sets a member cap');
    check(
      (await refused(() => assertCanSpend(memberScope))) === null,
      'the member can spend before reaching it'
    );
    const memberPersonalBefore = await balanceOf(member.id);
    await recordAgentSpend(memberScope, { tokenCostUsd: 0.01 });
    check((await balanceOf(SPACE)) < 50, 'the spend came out of the group');
    check(
      (await balanceOf(member.id)) === memberPersonalBefore,
      "and never out of the member's own"
    );
    // The cap is set from what was actually debited, because what one run costs
    // in credits depends on this deployment's billing settings.
    const spent = 50 - (await balanceOf(SPACE));
    await setMemberDailyCreditCap(admin.id, groupId, member.id, spent);
    check(
      (await refused(() => assertCanSpend(memberScope))) === 'DailyCreditCapError',
      `at the cap (${spent.toFixed(4)} credits in 24 hours) the member is refused before any provider call`
    );
    await setMemberDailyCreditCap(admin.id, groupId, member.id, null);
    check(
      (await refused(() => assertCanSpend(memberScope))) === null,
      'clearing the cap lets them spend again'
    );

    console.log('\nthe budget view: admins see spend, members see the balance');
    const memberView = await getGroupBudget(member.id, groupId);
    check(memberView.ok && memberView.value.admin === null, 'a member gets no per-person figures');
    const adminView = await getGroupBudget(admin.id, groupId);
    const rowsByUser = new Map(
      adminView.ok && adminView.value.admin
        ? adminView.value.admin.members.map((row) => [row.userId, row])
        : []
    );
    check(
      (rowsByUser.get(member.id)?.spentCredits ?? 0) > 0 &&
        rowsByUser.get(member.id)?.contributedCredits === 10 &&
        rowsByUser.get(admin.id)?.contributedCredits === 40,
      "an admin sees each person's spend and what they added"
    );

    console.log('\nthe alerts: on the crossing, admins only');
    await updateGroupBudgetSettings(admin.id, groupId, {
      lowBalanceAlertCredits: 45,
      largeRunAlertPercent: 50,
    });
    const crossing = await notifyGroupBudgetThresholds(memberScope, { before: 46, after: 44 });
    check(
      JSON.stringify(crossing.sent) === JSON.stringify(['low_balance']),
      'falling through the mark sends the low-balance alert'
    );
    const below = await notifyGroupBudgetThresholds(memberScope, { before: 44, after: 43 });
    check(below.sent.length === 0, 'already below it sends nothing');
    const lowAndLarge = await notifyGroupBudgetThresholds(memberScope, { before: 40, after: 10 });
    check(
      !lowAndLarge.sent.includes('large_run'),
      'a large run when the balance is already below the mark sends no second email'
    );
    const big = await notifyGroupBudgetThresholds(memberScope, { before: 100, after: 20 });
    check(big.sent.includes('large_run'), 'one run taking 80% of a healthy balance is a large run');
    const again = await notifyGroupBudgetThresholds(memberScope, { before: 100, after: 20 });
    check(!again.sent.includes('large_run'), 'and a second one the same day is not emailed again');

    console.log('\nthe digest: gated, and about the work');
    const background = backgroundSpaceScope({ spaceId: SPACE, kind: 'group' });
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);
    check(
      !(await hasResparkableActivitySince(SPACE, weekAgo)),
      'a week of money moving and no writing is a week a digest would not run'
    );
    await captureThought(memberScope, { content: `${PREFIX} book the venue`, source: 'web' });
    check(
      await hasResparkableActivitySince(SPACE, weekAgo),
      'one thought written by a member and it would'
    );
    const inputs = JSON.stringify(await buildGroupDigestInputs(background));
    check(
      [admin, member, viewer].every(
        (user) => !inputs.includes(user.id) && !inputs.includes(user.name)
      ),
      'the gather names nobody, though it read a row a member wrote'
    );
    check(
      (await refused(() =>
        writeReview(background, {
          horizon: 'group_digest',
          title: 'Week',
          body: `${member.name} was the most active.`,
        })
      )) === 'GroupDigestViolationError',
      'a digest naming a member is refused'
    );
    await writeReview(background, {
      horizon: 'group_digest',
      title: 'Week',
      body: 'One new thought arrived.',
    });
    check(
      (await getLatestGroupDigest(background))?.body === 'One new thought arrived.',
      'a digest about the work is stored and is what the page reads'
    );
    check(
      (await refused(() =>
        writeReview(spaceScope(admin.id), { horizon: 'group_digest', title: 'Week', body: 'x' })
      )) === 'NotAGroupSpaceError',
      'and a group digest cannot be written into a personal brain'
    );

    console.log('\nframework:resparkable:smoke-group-budget passed');
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
  console.error('framework:resparkable:smoke-group-budget FAILED');
  console.error(error);
  process.exit(1);
});
