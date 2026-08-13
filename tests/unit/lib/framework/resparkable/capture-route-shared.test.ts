/**
 * Unit Tests: `resolveCaptureRouteGating`.
 *
 * Extracted from `/transcribe` and `/transcribe/image`, which code review
 * flagged as duplicating this exact sequence near-verbatim — a real risk
 * since one of the three checks is the org-wide kill switch, and a fix
 * applied to only one route would silently leave the other on stale gating
 * behaviour. This file is now the one place that sequence is tested.
 *
 * @see lib/framework/resparkable/capture-route-shared.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiOrchestrationSettings: { findUnique: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
}));

import { resolveCaptureRouteGating } from '@/lib/framework/resparkable/capture-route-shared';
import { prisma } from '@/lib/db/client';

const AGENT_ROW = {
  id: 'agent_companion',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  fallbackProviders: [],
};

const DISABLED_ERROR = {
  message: 'Voice input is disabled at the platform level',
  code: 'VOICE_DISABLED',
};

function requestWithFormData(formData: FormData | (() => Promise<FormData>)) {
  return {
    formData: typeof formData === 'function' ? formData : async () => formData,
  } as unknown as Parameters<typeof resolveCaptureRouteGating>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
    voiceInputGloballyEnabled: true,
    imageInputGloballyEnabled: true,
  } as never);
  vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(AGENT_ROW as never);
});

describe('resolveCaptureRouteGating', () => {
  it('returns the agent and parsed formData on the happy path', async () => {
    const formData = new FormData();
    formData.set('x', '1');

    const result = await resolveCaptureRouteGating(
      requestWithFormData(formData),
      'voiceInputGloballyEnabled',
      DISABLED_ERROR
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agent).toEqual(AGENT_ROW);
      expect(result.value.formData.get('x')).toBe('1');
    }
  });

  it('refuses when the named kill switch is off, before resolving the agent', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      voiceInputGloballyEnabled: false,
    } as never);

    const result = await resolveCaptureRouteGating(
      requestWithFormData(new FormData()),
      'voiceInputGloballyEnabled',
      DISABLED_ERROR
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect((await result.response.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'VOICE_DISABLED' },
      });
    }
    expect(prisma.aiAgent.findUnique).not.toHaveBeenCalled();
  });

  it('checks the specific kill-switch field it was given, not a hardcoded one', async () => {
    // Voice stays enabled; only image is off. If the field name were
    // hardcoded to 'voiceInputGloballyEnabled', this call would wrongly pass.
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      voiceInputGloballyEnabled: true,
      imageInputGloballyEnabled: false,
    } as never);

    const result = await resolveCaptureRouteGating(
      requestWithFormData(new FormData()),
      'imageInputGloballyEnabled',
      { message: 'Image input is disabled at the platform level', code: 'IMAGE_DISABLED' }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((await result.response.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'IMAGE_DISABLED' },
      });
    }
  });

  it('passes through when no settings row exists — a fresh install with no operator opinion yet', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

    const result = await resolveCaptureRouteGating(
      requestWithFormData(new FormData()),
      'voiceInputGloballyEnabled',
      DISABLED_ERROR
    );

    expect(result.ok).toBe(true);
  });

  it('reports AGENT_NOT_SEEDED when the companion agent has not been seeded', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

    const result = await resolveCaptureRouteGating(
      requestWithFormData(new FormData()),
      'voiceInputGloballyEnabled',
      DISABLED_ERROR
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect((await result.response.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'AGENT_NOT_SEEDED' },
      });
    }
  });

  it('reports INVALID_BODY when the request is not multipart, without ever reaching the agent check twice', async () => {
    const result = await resolveCaptureRouteGating(
      requestWithFormData(() => Promise.reject(new Error('not multipart'))),
      'voiceInputGloballyEnabled',
      DISABLED_ERROR
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect((await result.response.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'INVALID_BODY' },
      });
    }
  });
});
