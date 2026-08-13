/**
 * POST /api/v1/resparkable/transcribe/image — vision extraction for the
 * capture box's camera button.
 *
 * ## Why this route exists, and why it isn't a `transcribe()`-shaped call
 *
 * Voice capture has `LlmProvider.transcribe()` — a single purpose-built method
 * any route can call. Vision has no equivalent: `enableImageInput` and
 * `assertModelSupportsAttachments` only exist inside the full chat pipeline
 * (`lib/orchestration/chat/streaming-handler.ts`), gated on a resolved agent
 * and a persisted `AiConversation`. This route composes the layer underneath
 * that instead — `LlmProvider.chat()` with a single multimodal message — the
 * same primitive the streaming handler builds attachments into, used here for
 * one throwaway completion rather than a stored turn. See
 * `.context/framework/resparkable/phase-9-plan.md` §1b for the full reasoning.
 *
 * ## What it gates on, and what it deliberately doesn't
 *
 * **The org-wide kill switch, yes.** `imageInputGloballyEnabled` is an
 * operator's "no image input on this instance" and it has to mean that
 * everywhere, not just on chat.
 *
 * **`resparkable-companion`'s own `enableImageInput`, no.** Same reasoning the
 * transcribe route gives for `enableVoiceInput`: that flag governs the mic (or
 * camera) on an agent's *chat* surface, where the media becomes a turn
 * addressed to that agent. Here there is no conversation — the extracted text
 * lands in a textarea the user edits and saves as their own note. The
 * companion is still resolved, but only so `assertModelSupportsAttachments`
 * has a model to check and the cost row is attributable to something.
 *
 * ## Nothing is persisted
 *
 * Same invariant as voice: the photo is sent to the provider and dropped. The
 * only write on the happy path is `logCost`. If someone wants the photo kept,
 * "Add to Documents" already exists for exactly that — see
 * `capture-attachment.tsx`.
 *
 * Rate limiting: `resparkable-image`, 10/min keyed on the session user,
 * registered in `lib/framework/resparkable/rate-limit.ts` (ahead of the
 * `/transcribe` rule, so it isn't shadowed by it).
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { RESPARKABLE_AGENT_SLUGS } from '@/lib/framework/resparkable/agents';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import {
  assertModelSupportsAttachments,
  getProviderWithFallbacks,
} from '@/lib/orchestration/llm/provider-manager';
import {
  enforceContentLengthCap,
  validateImageCaptureUpload,
} from '@/lib/validations/image-capture';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Fixed extraction instruction. Deliberately asks for a transcript, not a
 * caption — "a person jotting it down" is the register the capture box's own
 * drafts are already written in, so the result reads like something the user
 * could have typed, not a model describing an image back to them.
 */
const EXTRACTION_PROMPT =
  'Transcribe what is readable in this image as plain text a person would jot ' +
  'down themselves: printed or handwritten text, a diagram labelled in words, ' +
  'a whiteboard, a book page. If there is no readable text, briefly describe ' +
  'what the image shows instead. Reply with only the transcription or ' +
  'description — no preamble, no commentary.';

// Audit invariant: this handler MUST NOT persist image bytes. The only DB
// write on the happy path is `logCost(...)`.
export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const oversize = enforceContentLengthCap(request);
  if (oversize) return oversize;

  const settings = await prisma.aiOrchestrationSettings.findUnique({
    where: { slug: 'global' },
    select: { imageInputGloballyEnabled: true },
  });
  if (settings && !settings.imageInputGloballyEnabled) {
    return errorResponse('Image input is disabled at the platform level', {
      code: 'IMAGE_DISABLED',
      status: 403,
    });
  }

  // Resolved server-side for model/attribution — see the header. Its absence
  // means the Resparkable seeds have not been applied, an install problem
  // rather than a bad request.
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: RESPARKABLE_AGENT_SLUGS.companion },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) {
    return errorResponse('Resparkable is not fully installed on this instance', {
      code: 'AGENT_NOT_SEEDED',
      status: 503,
    });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse('Expected multipart/form-data body', {
      code: 'INVALID_BODY',
      status: 400,
    });
  }

  const validation = validateImageCaptureUpload(formData);
  if (!validation.ok) return validation.response;
  const { file } = validation.value;

  const { providerSlug, model, fallbacks } = await resolveAgentProviderAndModel(agent, 'chat');

  try {
    await assertModelSupportsAttachments(providerSlug, model, ['vision']);
  } catch (error) {
    if (error instanceof ProviderError && error.code === 'CAPABILITY_NOT_SUPPORTED') {
      return errorResponse('No vision-capable model is configured', {
        code: 'NO_VISION_PROVIDER',
        status: 503,
      });
    }
    throw error;
  }

  const { provider, usedSlug } = await getProviderWithFallbacks(providerSlug, fallbacks);

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const result = await provider.chat(
      [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', mediaType: file.type, data: buffer.toString('base64') },
            },
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        },
      ],
      { model }
    );

    void logCost({
      agentId: agent.id,
      model,
      provider: usedSlug,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      operation: 'vision',
      imageCount: 1,
      pdfCount: 0,
    });

    log.info('Resparkable image transcribed', {
      userId: session.user.id,
      provider: usedSlug,
      model,
      bytes: file.size,
    });

    return successResponse({ text: result.content });
  } catch (error) {
    log.error('Resparkable image extraction failed', {
      provider: usedSlug,
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Image extraction failed', {
      code: 'IMAGE_EXTRACTION_FAILED',
      status: 502,
    });
  }
});
