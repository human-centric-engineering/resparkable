/**
 * Resparkable "who pays" smoke (Release 9, phase 62).
 *
 * Proves against the **real** database what the unit tests can only assert
 * about call arguments: the raw-SQL debits on a member's own group balance, the
 * equal split's single transaction, the pool read net of members' debts, the
 * carved allowance, the automatic top-up's refusal to overdraw, and the
 * shortfall policies.
 *
 * No model is called and nothing is billed to a provider: spend is recorded
 * through `recordAgentSpend` with a made-up cost, which is the same write the
 * chat route and the billing pass make after a real run.
 *
 * Skips cleanly (exit 0) when no database is reachable. Self-cleaning: creates
 * only `smoke-resparkable-whopays-*` users and removes them, their group space
 * and everything in both on every path.
 *
 * Run with:
 *   npm run framework:resparkable:smoke-group-who-pays
 */

import { prisma } from '@/lib/db/client';
import {
  backgroundSpaceScope,
  spaceScope,
  type SpaceScope,
} from '@/lib/framework/resparkable/repo/space-scope';
import { assertCanSpend, recordAgentSpend } from '@/lib/framework/resparkable/services/billing';
import { canAffordOperational } from '@/lib/framework/resparkable/services/group-billing';
import {
  createGroup,
  resolveGroupMembership,
} from '@/lib/framework/resparkable/services/membership';
import { ensureResparkableSpace } from '@/lib/framework/resparkable/services/space';
import type { Prisma } from '@prisma/client';

const stamp = Date.now();
const PREFIX = 'smoke-resparkable-whopays';

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

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

async function refusal(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}

async function makeUser(label: string, balance: number): Promise<{ id: string }> {
  const user = await prisma.user.create({
    data: { name: `${PREFIX} ${label}`, email: `${PREFIX}-${label}-${stamp}@example.com` },
    select: { id: true },
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

async function memberRow(groupId: string, userId: string) {
  return prisma.resparkableGroupMember.findUniqueOrThrow({
    where: { groupId_userId: { groupId, userId } },
  });
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('framework:resparkable:smoke-group-who-pays skipped: no database');
    return;
  }

  const users: string[] = [];
  const spaces: string[] = [];

  try {
    const admin = await makeUser('admin', 100);
    const ana = await makeUser('ana', 50);
    const ben = await makeUser('ben', 50);
    users.push(admin.id, ana.id, ben.id);

    const created = await createGroup(admin.id, { name: `${PREFIX} ${stamp}` });
    const groupId = created.groupId;
    const SPACE = created.group.spaceId;
    spaces.push(SPACE);
    for (const user of [ana, ben]) {
      await prisma.resparkableGroupMember.create({
        data: { groupId, userId: user.id, role: 'member', joinedAt: new Date() },
      });
    }
    await prisma.resparkableCreditAccount.upsert({
      where: { spaceId: SPACE },
      create: { spaceId: SPACE, balanceCredits: 30 },
      update: { balanceCredits: 30 },
    });

    const scopeOf = async (userId: string): Promise<SpaceScope> => {
      const resolved = await resolveGroupMembership(userId, groupId);
      if (!resolved) throw new Error(`${userId} is not in the group`);
      return resolved.scope;
    };
    const configure = (data: Prisma.ResparkableGroupUpdateInput) =>
      prisma.resparkableGroup.update({ where: { id: groupId }, data });
    const setMember = (userId: string, data: Prisma.ResparkableGroupMemberUpdateInput) =>
      prisma.resparkableGroupMember.update({
        where: { groupId_userId: { groupId, userId } },
        data,
      });
    const anaScope = await scopeOf(ana.id);

    console.log('\npool (the default): phase 50, unchanged');
    const poolPlan = await assertCanSpend(anaScope);
    check(poolPlan.source === 'space', 'the plan is the pool');
    await recordAgentSpend(anaScope, { tokenCostUsd: 2, plan: poolPlan });
    check(near(await balanceOf(SPACE), 28), 'the pool paid 2');
    check(near(await balanceOf(ana.id), 50), "Ana's own balance was not touched");

    console.log('\nthe pool is read net of members’ debts');
    await setMember(ben.id, { balanceCredits: -28 });
    check(
      (await refusal(() => assertCanSpend(anaScope))) === 'InsufficientCreditsError',
      "a pool of 28 promised to Ben's debt of 28 refuses a run"
    );
    await setMember(ben.id, { balanceCredits: 0 });

    console.log('\nfilled allowance: each member spends their own group balance');
    await configure({ activityCostsPaidBy: 'allowance', allowanceSource: 'filled' });
    check(
      (await refusal(() => assertCanSpend(anaScope))) === null,
      'under debt, an empty own balance may borrow while the pool backs it'
    );
    await configure({ shortfallPolicy: 'suspend' });
    check(
      (await refusal(() => assertCanSpend(anaScope))) === 'InsufficientCreditsError',
      'under suspend, an empty own balance is refused'
    );
    await setMember(ana.id, { balanceCredits: 5 });
    const filledPlan = await assertCanSpend(anaScope);
    check(filledPlan.source === 'member', "the plan is Ana's own balance");
    await recordAgentSpend(anaScope, { tokenCostUsd: 7, plan: filledPlan });
    check(near((await memberRow(groupId, ana.id)).balanceCredits, -2), 'Ana went to -2');
    check(near(await balanceOf(SPACE), 28), 'the pool was not touched');
    check(near(await balanceOf(ana.id), 50), "Ana's personal balance was not touched");
    check(
      (await refusal(() => assertCanSpend(anaScope))) === 'GroupSuspendedError',
      'suspended below zero, whoever pays'
    );

    console.log('\nautomatic top-up: only what she agreed, never an overdraft');
    await setMember(ana.id, { autoTopUpMonthlyCredits: 10 });
    const afterTopUp = await assertCanSpend(anaScope);
    check(afterTopUp.source === 'member', 'the top-up let her run');
    check(near((await memberRow(groupId, ana.id)).balanceCredits, 8), 'her 10 paid the -2 first');
    check(near(await balanceOf(ana.id), 40), 'exactly 10 left her personal balance');
    await recordAgentSpend(anaScope, { tokenCostUsd: 9, plan: afterTopUp });
    check(
      near((await memberRow(groupId, ana.id)).balanceCredits, -1),
      'a month already topped up does not top up again'
    );
    check(near(await balanceOf(ana.id), 40), 'still exactly 10 out of her own balance');
    const autoRows = await prisma.resparkableCreditLedgerEntry.count({
      where: { kind: 'auto_top_up', createdByUserId: ana.id },
    });
    check(autoRows === 2, 'one row on each side, both hers');
    await setMember(ana.id, { autoTopUpMonthlyCredits: null, balanceCredits: 0 });
    await configure({ shortfallPolicy: 'debt' });

    console.log('\nequal split: all or nothing, one share per admin and member');
    await configure({ activityCostsPaidBy: 'equal_split' });
    for (const user of [admin, ana, ben]) await setMember(user.id, { balanceCredits: 10 });
    const splitPlan = await assertCanSpend(anaScope);
    check(splitPlan.source === 'split', 'the plan is a split');
    await recordAgentSpend(anaScope, { tokenCostUsd: 6, plan: splitPlan });
    for (const user of [admin, ana, ben]) {
      check(near((await memberRow(groupId, user.id)).balanceCredits, 8), 'each paid a third');
    }
    const shares = await prisma.resparkableCreditLedgerEntry.findMany({
      where: { spaceId: SPACE, kind: 'agent_spend', tokenCostUsd: 6 },
    });
    check(shares.length === 3, 'three share rows');
    check(
      shares.every((row) => row.createdByUserId === ana.id),
      'every share says Ana started the run'
    );
    const executionId = `exec_${stamp}`;
    await recordAgentSpend(anaScope, {
      tokenCostUsd: 3,
      relatedWorkflowExecutionId: executionId,
      authorUserId: ana.id,
    });
    const repeat = await refusal(() =>
      recordAgentSpend(anaScope, {
        tokenCostUsd: 3,
        relatedWorkflowExecutionId: executionId,
        authorUserId: ana.id,
      })
    );
    check(repeat !== null, 'billing the same run twice is refused by the ledger');
    for (const user of [admin, ana, ben]) {
      check(
        near((await memberRow(groupId, user.id)).balanceCredits, 7),
        'and the repeat rolled back whole: each paid one share of it'
      );
    }

    console.log('\ncarved allowance: a limit on the pool');
    await configure({ activityCostsPaidBy: 'allowance', allowanceSource: 'carved' });
    check(
      (await refusal(() => assertCanSpend(anaScope))) === 'GroupAllowanceUsedError',
      'no allowance left, refused'
    );
    await setMember(ana.id, { allowanceRemainingCredits: 4 });
    const carvedPlan = await assertCanSpend(anaScope);
    check(carvedPlan.source === 'allowance', 'the plan is the pool within her allowance');
    const poolBefore = await balanceOf(SPACE);
    await recordAgentSpend(anaScope, { tokenCostUsd: 3, plan: carvedPlan });
    check(near(await balanceOf(SPACE), poolBefore - 3), 'the pool paid');
    check(
      near((await memberRow(groupId, ana.id)).allowanceRemainingCredits, 1),
      'her allowance went down by the same'
    );

    console.log('\noperational: the digest’s payer');
    const background = backgroundSpaceScope({ spaceId: SPACE, kind: 'group' });
    await configure({ operationalCostsPaidBy: 'one_admin', operationalPayerUserId: admin.id });
    await setMember(admin.id, { balanceCredits: 0 });
    await configure({ shortfallPolicy: 'suspend' });
    check(
      !(await canAffordOperational(background)),
      'an empty payer under suspend skips the digest'
    );
    await setMember(admin.id, { balanceCredits: 2 });
    check(await canAffordOperational(background), 'a payer with credits can run it');
    await recordAgentSpend(background, { tokenCostUsd: 1, authorUserId: null });
    check(near((await memberRow(groupId, admin.id)).balanceCredits, 1), 'the admin paid it');
    await setMember(admin.id, { role: 'member' });
    const poolBeforeDemoted = await balanceOf(SPACE);
    await recordAgentSpend(background, { tokenCostUsd: 1, authorUserId: null });
    check(near(await balanceOf(SPACE), poolBeforeDemoted - 1), 'a demoted payer reads as the pool');
    await setMember(admin.id, { role: 'admin' });

    check(near(await balanceOf(ben.id), 50), "Ben's personal balance never moved");
    check(near(await balanceOf(spaceScope(admin.id).spaceId), 100), "nor the admin's");
    console.log('\nframework:resparkable:smoke-group-who-pays passed');
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
  console.error('framework:resparkable:smoke-group-who-pays FAILED');
  console.error(error);
  process.exit(1);
});
