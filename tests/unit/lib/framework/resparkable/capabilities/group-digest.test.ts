/**
 * Unit tests: `ResparkableGetGroupDigestInputsCapability` (`resparkable_get_group_digest_inputs`).
 *
 * The deterministic gather step the group-digest workflow calls before its one
 * model call. What is worth testing at this layer is the translation between
 * the service and a structured tool result, and that the audit row never
 * carries the titles the gather returns: see `services/group-digest.ts` for
 * why the gather itself carries no authorship.
 *
 * @see lib/framework/resparkable/capabilities/group-digest.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/framework/resparkable/services/group-digest', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/framework/resparkable/services/group-digest')>();
  return { ...actual, buildGroupDigestInputs: vi.fn() };
});

import { ResparkableGetGroupDigestInputsCapability } from '@/lib/framework/resparkable/capabilities/group-digest';
import {
  buildGroupDigestInputs,
  NotAGroupSpaceError,
  type GroupDigestInputs,
} from '@/lib/framework/resparkable/services/group-digest';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const mockedBuild = vi.mocked(buildGroupDigestInputs);

const ctx: CapabilityContext = { userId: 'user-a', agentId: 'agent-1' };

async function call(capability: ResparkableGetGroupDigestInputsCapability, raw: unknown) {
  const args = capability.validate(raw);
  return capability.execute(args, ctx);
}

const SAMPLE_INPUTS: GroupDigestInputs = {
  windowStart: '2026-09-14T08:00:00.000Z',
  windowEnd: '2026-09-21T08:00:00.000Z',
  moved: {
    total: 3,
    countsByType: { task: 3 },
    items: [{ entityType: 'task', title: 'Book the venue' }],
  },
  arrived: {
    total: 2,
    countsByType: { thought: 2 },
    items: [{ entityType: 'thought', title: 'Pricing idea' }],
  },
  connections: { unreviewed: 1, items: [{ from: 'Pricing idea', to: 'Launch plan' }] },
  stalled: [{ label: 'Projects', rows: [{ title: 'Rebrand', untouchedDays: 20 }] } as never],
  unclaimed: [{ title: 'Book the venue', untouchedDays: 15 }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resparkable_get_group_digest_inputs', () => {
  const capability = new ResparkableGetGroupDigestInputsCapability();

  it('takes no arguments and rejects any', () => {
    expect(() => capability.validate({ groupId: 'grp_1' })).toThrow();
  });

  it("passes the scope's gathered inputs through as the result", async () => {
    mockedBuild.mockResolvedValue(SAMPLE_INPUTS);

    const result = await call(capability, {});

    expect(result).toMatchObject({ success: true, data: SAMPLE_INPUTS });
  });

  it('maps a personal-space refusal to a structured not_a_group_space result', async () => {
    mockedBuild.mockRejectedValue(new NotAGroupSpaceError());

    const result = await call(capability, {});

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'not_a_group_space',
        message: expect.stringContaining('group workspace'),
      },
    });
  });

  it('lets an unexpected fault escape rather than flattening it into a tool result', async () => {
    mockedBuild.mockRejectedValue(new Error('connection reset'));

    await expect(call(capability, {})).rejects.toThrow('connection reset');
  });

  it('never puts a gathered title into the audit row, whatever the result held', () => {
    const redaction = capability.redactProvenance({}, { success: true, data: SAMPLE_INPUTS });

    expect(redaction.args).toEqual({});
    const preview = JSON.stringify(redaction.resultPreview);
    expect(preview).not.toContain('Book the venue');
    expect(preview).not.toContain('Pricing idea');
    expect(preview).not.toContain('Launch plan');
    expect(preview).not.toContain('Rebrand');
  });
});
