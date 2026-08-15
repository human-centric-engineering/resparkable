/**
 * Unit Tests: `ResparkableGetContextDigestCapability` (`resparkable_get_context_digest`).
 *
 * The deterministic gather step the description-summariser workflow calls
 * before the one LLM call in it runs — a thin wrapper: this tests the
 * translation between the service's `null` and a structured `not_found`
 * result, and that the audit row never carries note content.
 *
 * @see lib/framework/resparkable/capabilities/context-digest.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/framework/resparkable/services/context-digest', () => ({
  buildContextDigest: vi.fn(),
}));

import { ResparkableGetContextDigestCapability } from '@/lib/framework/resparkable/capabilities/context-digest';
import { buildContextDigest } from '@/lib/framework/resparkable/services/context-digest';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';
import type { ContextDigest } from '@/lib/framework/resparkable/services/context-digest';

const mockedBuild = vi.mocked(buildContextDigest);

const ctx: CapabilityContext = { userId: 'user-a', agentId: 'agent-1' };

async function call(capability: ResparkableGetContextDigestCapability, raw: unknown) {
  const args = capability.validate(raw);
  return capability.execute(args, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resparkable_get_context_digest', () => {
  const capability = new ResparkableGetContextDigestCapability();

  it('returns not_found rather than throwing when the item does not resolve', async () => {
    mockedBuild.mockResolvedValue(null);

    const result = await call(capability, {
      entityType: 'area',
      entityId: 'clh0000000000000000000012',
    });

    expect(result).toMatchObject({ success: false, error: { code: 'not_found' } });
  });

  it('passes the built digest straight through on success', async () => {
    const digest: ContextDigest = {
      entityType: 'area',
      entityId: 'clh0000000000000000000012',
      entityName: 'Health',
      currentDescription: null,
      notes: [{ id: 't1', content: 'Went for a run', capturedAt: '2026-01-01T00:00:00.000Z' }],
      sourceThoughtIds: ['t1'],
      sourceLinkIds: ['link1'],
    };
    mockedBuild.mockResolvedValue(digest);

    const result = await call(capability, {
      entityType: 'area',
      entityId: 'clh0000000000000000000012',
    });

    expect(result).toMatchObject({ success: true, data: digest });
  });

  it('keeps the args but never the note content in the audit row', () => {
    const digest: ContextDigest = {
      entityType: 'area',
      entityId: 'clh0000000000000000000012',
      entityName: 'Health',
      currentDescription: null,
      notes: [
        {
          id: 't1',
          content: 'A private note about my health',
          capturedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      sourceThoughtIds: ['t1'],
      sourceLinkIds: ['link1'],
    };

    const redaction = capability.redactProvenance(
      { entityType: 'area', entityId: 'clh0000000000000000000012' },
      { success: true, data: digest }
    );

    expect(redaction.args).toEqual({ entityType: 'area', entityId: 'clh0000000000000000000012' });
    expect(JSON.stringify(redaction.resultPreview)).not.toContain('private note about my health');
  });
});
