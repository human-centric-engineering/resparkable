/**
 * Unit Tests: `ResparkableCaptureContextCapability` (`resparkable_capture_context`).
 *
 * The capture door for a "tell me more" conversation. Two things are load-
 * bearing and neither is visible from the schema alone:
 *
 *   - `source` is pinned to `'chat'`, never an argument — same trust-boundary
 *     rule `resparkable_capture` applies to `'agent'`.
 *   - The link target comes from `context.entityContext`, which the model
 *     cannot set (it isn't a schema field), and a malformed or absent one is
 *     not an error — it just means no link gets created, the same "skip,
 *     don't throw" posture as every other dangling-endpoint case in this tier.
 *
 * Test Coverage:
 * - Pins source to 'chat' regardless of what content is captured
 * - Creates a link via the shared `linkEntities` service when entityContext resolves
 * - Creates no link when entityContext is absent (the freeform surface)
 * - Creates no link when entityContext is malformed
 * - Reports `linkedTo: null` without throwing when `linkEntities` returns null
 *   (the target doesn't exist or isn't the caller's — same as any other id)
 * - `redactProvenance` masks content, keeps the shape
 *
 * @see lib/framework/resparkable/capabilities/capture-context.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/framework/resparkable/services/capture', () => ({ captureThought: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/links', () => ({ linkEntities: vi.fn() }));

import { ResparkableCaptureContextCapability } from '@/lib/framework/resparkable/capabilities/capture-context';
import { captureThought } from '@/lib/framework/resparkable/services/capture';
import { linkEntities } from '@/lib/framework/resparkable/services/links';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';
import type { ResparkableLink, ResparkableThought } from '@prisma/client';

const mockedCapture = vi.mocked(captureThought);
const mockedLink = vi.mocked(linkEntities);

const THOUGHT_ID = 'clh0000000000000000000009';
const AREA_ID = 'clh0000000000000000000010';

const THOUGHT = {
  id: THOUGHT_ID,
  createdAt: new Date('2026-08-04T09:00:00Z'),
} as ResparkableThought;

function baseCtx(entityContext?: Record<string, unknown>): CapabilityContext {
  return { userId: 'user-a', agentId: 'agent-1', ...(entityContext ? { entityContext } : {}) };
}

async function call(capability: ResparkableCaptureContextCapability, ctx: CapabilityContext) {
  const args = capability.validate({ content: 'Something worth keeping' });
  return capability.execute(args, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCapture.mockResolvedValue({ thought: THOUGHT, deduped: false });
});

describe('resparkable_capture_context', () => {
  const capability = new ResparkableCaptureContextCapability();

  it("pins source to 'chat' rather than accepting one", async () => {
    await call(capability, baseCtx());

    expect(mockedCapture).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-a' }),
      expect.objectContaining({ content: 'Something worth keeping', source: 'chat' })
    );
  });

  it('rejects an attempt to supply a source at all', () => {
    expect(() => capability.validate({ content: 'x', source: 'voice' })).toThrow();
  });

  it('creates a link when entityContext resolves to a valid anchor', async () => {
    mockedLink.mockResolvedValue({ id: 'link_1' } as ResparkableLink);

    const result = await call(capability, baseCtx({ entityType: 'area', entityId: AREA_ID }));

    expect(mockedLink).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-a' }),
      expect.objectContaining({
        sourceType: 'thought',
        sourceId: THOUGHT_ID,
        targetType: 'area',
        targetId: AREA_ID,
        kind: 'relates_to',
      })
    );
    expect(result).toMatchObject({
      success: true,
      data: { linkedTo: { entityType: 'area', entityId: AREA_ID } },
    });
  });

  it('creates no link when entityContext is absent — the freeform surface', async () => {
    const result = await call(capability, baseCtx());

    expect(mockedLink).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, data: { linkedTo: null } });
  });

  it('creates no link when entityContext is malformed, rather than throwing', async () => {
    const result = await call(
      capability,
      baseCtx({ entityType: 'not_a_real_type', entityId: AREA_ID })
    );

    expect(mockedLink).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, data: { linkedTo: null } });
  });

  it('reports linkedTo: null when the target isn’t the caller’s — same as any other dangling id', async () => {
    mockedLink.mockResolvedValue(null);

    const result = await call(
      capability,
      baseCtx({ entityType: 'project', entityId: 'clh0000000000000000000011' })
    );

    expect(result).toMatchObject({ success: true, data: { linkedTo: null } });
  });

  it('redacts content in the audit row', () => {
    const redaction = capability.redactProvenance(
      { content: 'A long private paragraph about my week' },
      {
        success: true,
        data: {
          id: THOUGHT_ID,
          deduped: false,
          capturedAt: '2026-08-04T09:00:00.000Z',
          linkedTo: null,
        },
      }
    );

    expect(redaction.args).not.toHaveProperty('content', 'A long private paragraph about my week');
    expect(JSON.stringify(redaction.args)).not.toContain('private paragraph');
  });
});
