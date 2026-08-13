/**
 * The gating three steps `/transcribe` and `/transcribe/image` share.
 *
 * Extracted after code review flagged the org-wide kill switch, the
 * companion-agent lookup and the `formData()` parse as duplicated near-
 * verbatim between the two routes — a real risk, not just repetition: a
 * future change to how the kill switch is read would silently apply to only
 * whichever route got edited. Both routes still own their own upload
 * validation, provider call and error mapping — those genuinely differ
 * (audio vs image), so only the identical prefix moves here.
 *
 * Reads the database through `repo/agents.ts` and `repo/orchestration-settings.ts`
 * rather than importing `prisma` directly — this file lives outside `repo/**`,
 * where the tier's own ESLint boundary (D5) forbids that.
 */

import type { NextRequest } from 'next/server';
import { errorResponse } from '@/lib/api/responses';
import { RESPARKABLE_AGENT_SLUGS } from '@/lib/framework/resparkable/agents';
import {
  findAgentBinding,
  type ResparkableAgentBinding,
} from '@/lib/framework/resparkable/repo/agents';
import {
  findCaptureKillSwitch,
  type CaptureKillSwitchField,
} from '@/lib/framework/resparkable/repo/orchestration-settings';

export interface CaptureRouteContext {
  /**
   * The resolved `resparkable-companion` row. `/transcribe` only needs `id`
   * (cost attribution); `/transcribe/image` also needs `provider`/`model`/
   * `fallbackProviders` for `resolveAgentProviderAndModel` — `findAgentBinding`
   * already selects all four, so there's nothing to parametrise here.
   */
  agent: ResparkableAgentBinding;
  formData: FormData;
}

export type CaptureRouteGatingResult =
  { ok: true; value: CaptureRouteContext } | { ok: false; response: Response };

/**
 * Checks the org-wide kill switch, resolves the companion agent, and parses
 * the multipart body — in that order, matching both routes' original
 * behaviour exactly (a request that would fail more than one check gets the
 * same error either route already returned).
 *
 * `killSwitchField` and `disabledError` are the one thing that differs
 * between callers; everything else here was identical.
 */
export async function resolveCaptureRouteGating(
  request: NextRequest,
  killSwitchField: CaptureKillSwitchField,
  disabledError: { message: string; code: string }
): Promise<CaptureRouteGatingResult> {
  const enabled = await findCaptureKillSwitch(killSwitchField);
  if (!enabled) {
    return {
      ok: false,
      response: errorResponse(disabledError.message, { code: disabledError.code, status: 403 }),
    };
  }

  // Resolved server-side and used only for cost attribution — see each
  // route's own header. Its absence means the Resparkable seeds have not
  // been applied, which is an install problem rather than a bad request.
  const agent = await findAgentBinding(RESPARKABLE_AGENT_SLUGS.companion);
  if (!agent) {
    return {
      ok: false,
      response: errorResponse('Resparkable is not fully installed on this instance', {
        code: 'AGENT_NOT_SEEDED',
        status: 503,
      }),
    };
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return {
      ok: false,
      response: errorResponse('Expected multipart/form-data body', {
        code: 'INVALID_BODY',
        status: 400,
      }),
    };
  }

  return { ok: true, value: { agent, formData } };
}
