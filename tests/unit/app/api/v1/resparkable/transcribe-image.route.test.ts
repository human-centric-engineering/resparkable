/**
 * Unit Tests: POST /api/v1/resparkable/transcribe/image
 *
 * What this pins down, mirroring `capture-attachments.routes.test.ts`'s
 * transcribe coverage for the same reasons:
 *
 *   1. **Returns extracted text, nothing more.** No conversation, no stored
 *      original — see the route's own audit-invariant comment.
 *   2. **The org-wide kill switch and "no vision model configured" answer
 *      distinctly** — `imageInputGloballyEnabled` vs a model that fails
 *      `assertModelSupportsAttachments`, because the fixes differ (flip a
 *      setting vs configure/select a vision-capable model).
 *   3. **A provider failure is a gateway error, and logs no cost** — nothing
 *      to bill for a call that never produced a result.
 *   4. **The upload guard rejects non-image and oversize bodies** before the
 *      provider is ever touched.
 *
 * @see app/api/v1/resparkable/transcribe/image/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/guards', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown, context: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session, context);
      } catch (error) {
        return handleAPIError(error);
      }
    },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiOrchestrationSettings: { findUnique: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  assertModelSupportsAttachments: vi.fn(),
  getProviderWithFallbacks: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({ logCost: vi.fn() }));

import { POST } from '@/app/api/v1/resparkable/transcribe/image/route';
import { getRouteLogger } from '@/lib/api/context';
import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import {
  assertModelSupportsAttachments,
  getProviderWithFallbacks,
} from '@/lib/orchestration/llm/provider-manager';

const SESSION = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function invoke(request: unknown): Promise<Response> {
  return (POST as unknown as (...args: unknown[]) => Promise<Response>)(request, SESSION);
}

function multipartRequest(
  entries: Record<string, File | string>,
  opts: { contentLength?: string; formDataSpy?: ReturnType<typeof vi.fn> } = {}
): { request: Request; formData: FormData } {
  const formData = new FormData();
  for (const [key, value] of Object.entries(entries)) formData.set(key, value);

  const headerInit: Record<string, string> = {};
  if (opts.contentLength !== undefined) headerInit['content-length'] = opts.contentLength;

  return {
    request: {
      url: 'http://x/api/v1/resparkable/transcribe/image',
      headers: new Headers(headerInit),
      formData: opts.formDataSpy ?? vi.fn(async () => formData),
    } as unknown as Request,
    formData,
  };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const IMAGE = new File([new Uint8Array(64)], 'photo.jpg', { type: 'image/jpeg' });

function imageRequest(entries: Record<string, File | string> = {}) {
  return multipartRequest({ image: IMAGE, ...entries });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRouteLogger).mockResolvedValue(makeLog() as never);

  vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
    imageInputGloballyEnabled: true,
  } as never);
  vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
    id: 'agent_companion',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    fallbackProviders: [],
  } as never);
  vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
    providerSlug: 'anthropic',
    model: 'claude-sonnet-4-6',
    fallbacks: [],
  });
  vi.mocked(assertModelSupportsAttachments).mockResolvedValue(undefined);
  vi.mocked(getProviderWithFallbacks).mockResolvedValue({
    provider: {
      chat: vi.fn(async () => ({
        content: 'Buy milk, call the dentist',
        usage: { inputTokens: 200, outputTokens: 12 },
        model: 'claude-sonnet-4-6',
        finishReason: 'stop',
      })),
    },
    usedSlug: 'anthropic',
  } as never);
});

describe('POST /api/v1/resparkable/transcribe/image', () => {
  it('returns the extracted text', async () => {
    const { request } = imageRequest();
    const response = await invoke(request);

    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({ text: 'Buy milk, call the dentist' });
  });

  it('logs a vision cost row attributed to the companion, not tokens', async () => {
    const { request } = imageRequest();
    await invoke(request);

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent_companion',
        operation: 'vision',
        imageCount: 1,
        pdfCount: 0,
      })
    );
  });

  it('refuses when the platform kill switch is off', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      imageInputGloballyEnabled: false,
    } as never);

    const { request } = imageRequest();
    const response = await invoke(request);

    expect(response.status).toBe(403);
    expect((await body(response)).error).toMatchObject({ code: 'IMAGE_DISABLED' });
    // Nothing was sent anywhere.
    expect(getProviderWithFallbacks).not.toHaveBeenCalled();
  });

  it('reports 503 when the resolved agent has no vision-capable model', async () => {
    vi.mocked(assertModelSupportsAttachments).mockRejectedValue(
      new ProviderError('nope', { code: 'CAPABILITY_NOT_SUPPORTED', retriable: false })
    );

    const { request } = imageRequest();
    const response = await invoke(request);

    expect(response.status).toBe(503);
    expect((await body(response)).error).toMatchObject({ code: 'NO_VISION_PROVIDER' });
    expect(getProviderWithFallbacks).not.toHaveBeenCalled();
  });

  it('reports 503 when the tier is not seeded', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

    const { request } = imageRequest();
    const response = await invoke(request);

    expect(response.status).toBe(503);
    expect((await body(response)).error).toMatchObject({ code: 'AGENT_NOT_SEEDED' });
  });

  it('reports a provider failure as a gateway error and logs no cost', async () => {
    vi.mocked(getProviderWithFallbacks).mockResolvedValue({
      provider: {
        chat: vi.fn(async () => {
          throw new Error('upstream exploded');
        }),
      },
      usedSlug: 'anthropic',
    } as never);

    const { request } = imageRequest();
    const response = await invoke(request);

    expect(response.status).toBe(502);
    expect((await body(response)).error).toMatchObject({ code: 'IMAGE_EXTRACTION_FAILED' });
    expect(logCost).not.toHaveBeenCalled();
  });

  it('rejects a non-image upload', async () => {
    const { request } = multipartRequest({
      image: new File(['not an image'], 'notes.md', { type: 'text/markdown' }),
    });

    const response = await invoke(request);
    expect(response.status).toBe(415);
    expect(getProviderWithFallbacks).not.toHaveBeenCalled();
  });

  it('rejects an oversize body BEFORE materialising it', async () => {
    const formDataSpy = vi.fn();
    const { request } = multipartRequest(
      { image: IMAGE },
      { contentLength: String(10 * 1024 * 1024 + 5000), formDataSpy }
    );

    const response = await invoke(request);
    expect(response.status).toBe(413);
    // The guard is worthless if the body has already been read into memory.
    expect(formDataSpy).not.toHaveBeenCalled();
  });
});
