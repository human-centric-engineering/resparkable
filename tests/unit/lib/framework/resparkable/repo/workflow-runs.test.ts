/**
 * Unit Tests: queueing a background workflow run, and the owner-contact lookup.
 *
 * This is the one place Resparkable writes to a **core-owned** table, and the
 * property that makes it dangerous is asserted here: the row it writes has to
 * be one the maintenance tick will actually pick up.
 *
 * The bulk of this file used to be about per-user `AiWorkflowSchedule` rows —
 * creating them, correcting their crons after a DST change, stamping owners
 * onto pre-0.8.0 rows, clearing stale `inputTemplate`s, deleting them inside
 * the erasure transaction, sweeping up the orphans behind an erasure hook that
 * might not have fired. Phase 56 deleted all of it: the queue owns *when*
 * per-user work happens, it stores an instant rather than an expression, and
 * `ResparkableJob` is inside the `ResparkableSpace` cascade so erasure needs no
 * code at all. Those tests went with the code they covered.
 *
 * What is left is the trigger, which was never the part that was wrong.
 *
 * Test Coverage:
 * - Queueing pins the published version and stamps the owner from the caller
 * - The status written is the exact lower-case value every consumer selects on
 * - No published version, an inactive workflow or an unknown slug queue nothing
 * - `findOwnerContact` is scope-bound and returns null for a gone account
 *
 * @see lib/framework/resparkable/repo/workflow-runs.ts
 * @see lib/framework/resparkable/repo/owner-contact.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: { findUnique: vi.fn() },
    aiWorkflowExecution: { create: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

import { prisma } from '@/lib/db/client';
import { queueResparkableWorkflowRun } from '@/lib/framework/resparkable/repo/workflow-runs';
import { findOwnerContact } from '@/lib/framework/resparkable/repo/owner-contact';
import { spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { WorkflowStatus } from '@/types/orchestration';

const SCOPE = spaceScope('user_a');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('queueResparkableWorkflowRun', () => {
  it('pins the published version and stamps the owner from the caller', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
      id: 'wf1',
      isActive: true,
      maxCostPerExecutionUsd: 0.25,
      publishedVersionId: 'v1',
    } as never);
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({ id: 'exec1' } as never);

    const id = await queueResparkableWorkflowRun('resparkable-morning-briefing', 'user_a', {});

    expect(id).toBe('exec1');
    const data = vi.mocked(prisma.aiWorkflowExecution.create).mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({
      workflowId: 'wf1',
      versionId: 'v1',
      status: WorkflowStatus.PENDING,
      userId: 'user_a',
      budgetLimitUsd: 0.25,
    });
  });

  it('writes the status the tick actually selects on, not an upper-cased lookalike', async () => {
    // `AiWorkflowExecution.status` is a plain `String`, so the comparison is
    // byte-exact. An earlier version wrote the literal `'PENDING'`, which every
    // consumer — `processPendingExecutions`, the reaper, the stuck-execution
    // dashboard — filters past, so the row was never run, never failed and
    // never shown, while the route answered `queued`. Asserting the constant
    // alone would not have caught it: `toMatchObject` would still have passed
    // had the constant itself been upper-case. This pins the wire value.
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
      id: 'wf1',
      isActive: true,
      maxCostPerExecutionUsd: null,
      publishedVersionId: 'v1',
    } as never);
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({ id: 'exec1' } as never);

    await queueResparkableWorkflowRun('resparkable-morning-briefing', 'user_a', {});

    const data = vi.mocked(prisma.aiWorkflowExecution.create).mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({ status: 'pending' });
  });

  it('returns null rather than queueing a run nothing will execute', async () => {
    // No published version means the seeds have not run. Writing a PENDING row
    // would leave it sitting there for ever.
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
      id: 'wf1',
      isActive: true,
      maxCostPerExecutionUsd: null,
      publishedVersionId: null,
    } as never);

    expect(
      await queueResparkableWorkflowRun('resparkable-morning-briefing', 'user_a', {})
    ).toBeNull();
    expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled();
  });

  it('refuses a deactivated workflow', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
      id: 'wf1',
      isActive: false,
      maxCostPerExecutionUsd: null,
      publishedVersionId: 'v1',
    } as never);

    expect(
      await queueResparkableWorkflowRun('resparkable-morning-briefing', 'user_a', {})
    ).toBeNull();
    expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled();
  });

  it('refuses an unknown slug', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);

    expect(await queueResparkableWorkflowRun('resparkable-nope', 'user_a', {})).toBeNull();
  });
});

describe('findOwnerContact', () => {
  it('looks the address up by the scope owner, at call time', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      email: 'owner@example.com',
      name: 'Owner',
    } as never);

    const contact = await findOwnerContact(SCOPE);

    expect(vi.mocked(prisma.user.findUnique).mock.calls[0]?.[0]?.where).toEqual({ id: 'user_a' });
    expect(contact).toEqual({ email: 'owner@example.com', name: 'Owner' });
  });

  it('returns null for an erased account rather than throwing', async () => {
    // The orphaned-schedule case: a background run holding a userId whose user
    // is gone. The caller skips quietly; a throw would fail the workflow.
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    expect(await findOwnerContact(SCOPE)).toBeNull();
  });

  it('normalises a missing display name to null', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      email: 'owner@example.com',
      name: null,
    } as never);

    expect(await findOwnerContact(SCOPE)).toEqual({ email: 'owner@example.com', name: null });
  });

  it('treats a missing address as no contact', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ email: '', name: null } as never);

    expect(await findOwnerContact(SCOPE)).toBeNull();
  });
});
