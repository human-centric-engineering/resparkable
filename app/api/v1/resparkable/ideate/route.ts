/**
 * POST /api/v1/resparkable/ideate — ask for framings rather than waiting for them.
 *
 * The nightly sweep notices connections on its own schedule; this is the person
 * asking. It pulls the seed's nearest neighbours with a **wider** floor than the
 * sweep uses — the interesting framings come from the pairs that are nearly
 * unrelated — and asks a model for N of them.
 *
 * **Read-only.** Nothing is written but an `AiCostLog` row. There is no link to
 * accept, no thought to clean up, and calling it twice costs money but changes
 * nothing.
 *
 * `POST` rather than `GET` despite being a read: it spends money and takes
 * seconds, and neither is something a browser should feel free to prefetch or a
 * proxy to cache.
 *
 * Rate limiting: per-flow sub-cap registered in `lib/framework/resparkable/rate-limit.ts`.
 * It is the only route in phase 6a that makes an LLM call.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import {
  assertPositiveBalance,
  recordAgentSpend,
} from '@/lib/framework/resparkable/services/billing';
import { ideate } from '@/lib/framework/resparkable/services/ideate';
import { ensureResparkableSpace } from '@/lib/framework/resparkable/services/space';
import { ideateSchema } from '@/lib/framework/resparkable/validations';
import { logger } from '@/lib/logging';

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = spaceScope(session.user.id);

  const body = await validateRequestBody(request, ideateSchema);

  // A credit account's FK requires the space row to already exist; idempotent.
  await ensureResparkableSpace(session.user.id);
  // Refused before any provider call: see services/billing.ts. Throws
  // InsufficientCreditsError, turned into a 402 by withAuth's error handler.
  await assertPositiveBalance(scope);

  const result = await ideate(scope, body);

  // Best-effort: the compute already happened, so a ledger-write failure logs
  // rather than turning an otherwise-successful response into an error.
  try {
    await recordAgentSpend(scope, { tokenCostUsd: result.costUsd });
  } catch (error) {
    logger.error('Resparkable ideate spend could not be recorded', error, {
      userId: session.user.id,
    });
  }

  log.info('Resparkable ideate', {
    seedType: body.seedType,
    framings: result.framings.length,
    notIndexedYet: result.notIndexedYet,
  });

  return successResponse(result);
});
