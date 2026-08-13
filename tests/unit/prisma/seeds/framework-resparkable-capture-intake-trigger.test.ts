/**
 * Unit Tests: `framework-resparkable/008-capture-intake-trigger`.
 *
 * This seed writes the one row standing between "the capability and the
 * workflow exist" and "an inbound email actually fires them" — the
 * `AiWorkflowTrigger` pointing Postmark's channel at
 * `resparkable-capture-intake`. Everything else in the inbound path (the
 * adapter, the route, Basic-auth verification) is already generic platform
 * code; this seed is the whole of what phase 9 adds to it.
 *
 * Test Coverage:
 * - Creates a `channel: 'postmark'` trigger pointed at the seeded workflow's id
 * - Fails loudly when the capture-intake workflow has not been seeded
 * - The update branch touches nothing — `isEnabled` stays an operator's to hold
 *
 * @see prisma/seeds/framework-resparkable/008-capture-intake-trigger.ts
 */

import { describe, expect, it, vi } from 'vitest';

import unit from '@/prisma/seeds/framework-resparkable/008-capture-intake-trigger';
import { RESPARKABLE_CAPTURE_INTAKE_WORKFLOW_SLUG } from '@/lib/framework/resparkable/workflows/definitions';
import type { SeedContext } from '@/prisma/runner';

function ctxFor(overrides: Record<string, unknown>): {
  ctx: SeedContext;
  calls: { triggerUpsert: ReturnType<typeof vi.fn> };
} {
  const calls = { triggerUpsert: vi.fn().mockResolvedValue({}) };

  const ctx = {
    prisma: {
      user: { findFirst: vi.fn().mockResolvedValue({ id: 'admin-1' }) },
      aiWorkflow: { findUnique: vi.fn().mockResolvedValue({ id: 'wf-capture-intake' }) },
      aiWorkflowTrigger: { upsert: calls.triggerUpsert },
      ...overrides,
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as SeedContext;

  return { ctx, calls };
}

describe('framework-resparkable/008-capture-intake-trigger', () => {
  it('creates a postmark trigger pointed at the capture-intake workflow', async () => {
    const { ctx, calls } = ctxFor({});

    await unit.run(ctx);

    expect(calls.triggerUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { channel_workflowId: { channel: 'postmark', workflowId: 'wf-capture-intake' } },
        create: expect.objectContaining({
          workflowId: 'wf-capture-intake',
          channel: 'postmark',
          isEnabled: true,
          createdBy: 'admin-1',
        }),
      })
    );
  });

  it('resolves the workflow by its real slug', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'wf-capture-intake' });
    const { ctx } = ctxFor({ aiWorkflow: { findUnique } });

    await unit.run(ctx);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: RESPARKABLE_CAPTURE_INTAKE_WORKFLOW_SLUG } })
    );
  });

  it('never rewrites an operator-held field on re-seed', async () => {
    const { ctx, calls } = ctxFor({});

    await unit.run(ctx);

    expect(calls.triggerUpsert.mock.calls[0]?.[0]).toMatchObject({ update: {} });
  });

  it('fails loudly when the capture-intake workflow has not been seeded', async () => {
    const { ctx } = ctxFor({ aiWorkflow: { findUnique: vi.fn().mockResolvedValue(null) } });

    await expect(unit.run(ctx)).rejects.toThrow(/005-workflows/);
  });

  it('fails loudly when the admin user has not been seeded', async () => {
    const { ctx } = ctxFor({ user: { findFirst: vi.fn().mockResolvedValue(null) } });

    await expect(unit.run(ctx)).rejects.toThrow(/admin user/i);
  });
});
