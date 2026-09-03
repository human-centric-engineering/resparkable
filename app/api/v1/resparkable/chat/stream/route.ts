/**
 * POST /api/v1/resparkable/chat/stream — the app-owned chat surface (SSE).
 *
 * ## Why Resparkable owns a chat route at all
 *
 * The platform ships two, and neither fits (plan §5):
 *
 *   - `/api/v1/chat/stream` deliberately **drops `contextType` / `contextId`** —
 *     they are admin-only concepts there. Those two fields are exactly what the
 *     "always knows my goals" block travels on, so the consumer route gives an
 *     agent with tools and no idea who it is talking to.
 *   - `/api/v1/admin/orchestration/chat/stream` carries them, and requires
 *     `withAdminAuth`. A personal second brain whose chat needs an admin session
 *     is not a product.
 *
 * So: `withAuth`, `streamChat` directly, and both context fields pinned here.
 *
 * ## The two things pinned server-side
 *
 * **`contextId` is the RESOLVED workspace, never client-supplied.** It was
 * `session.user.id` until phase 47, which was the same value while a person had
 * one brain. It is now `scope.spaceId`, and the scope came from
 * `requestSpaceScope`, which read `?space=` and then read membership — so the
 * id pinned here is one this session is entitled to, and the body field named
 * `contextId` is still ignored outright. `buildContext` caches on
 * `type:id:userId`, so this is also what gives a group turn its own cache
 * entry rather than serving the actor's personal context inside a shared brain.
 *
 * The same resolved id travels a second time as `scope`, which is what reaches
 * a capability's `CapabilityContext`. Core routes that through `hintScope` and
 * calls it a hint, correctly, because a consumer body can set it; the tier's
 * `requireResparkableSpace` re-resolves it against membership rather than
 * trusting it. Two paths for one value is not duplication: `contextId` feeds
 * the prompt's context block and `scope` feeds the tools, and they are read by
 * different code with different trust rules.
 *
 * **`agentSlug` is checked against `RESPARKABLE_CHAT_AGENT_SLUGS`.** That list is a
 * security boundary, not a UI convenience: `resparkable-triage` and
 * `resparkable-strategist` hold write capabilities and are meant to be driven by
 * scheduled workflows, where their input is the user's own data. Letting a
 * browser drive them would hand a prompt-injected document a write path tuned
 * with a different guard profile than the companion's. `streamChat` itself does
 * **not** gate on `AiAgent.visibility` — confirmed in the handler — which is
 * what lets `resparkable-companion` stay `internal`, and is also why the check has
 * to happen here.
 *
 * ## `entityContext`
 *
 * Forwarded verbatim into `CapabilityContext` when a "tell me more" chat is
 * opened from an Area/Goal/Project page — this route does not trust the id it
 * carries, only bounds its shape (`resparkableEntityContextSchema`). The
 * capability that reads it (`resparkable_capture_context`) re-verifies
 * ownership before acting, the same way `resparkable_link_entities` already
 * does for a hand-made link.
 *
 * ## Rate limiting
 *
 * `resparkable-chat`, 20/min keyed on the session user, registered in
 * `lib/framework/resparkable/rate-limit.ts` and applied by `proxy.ts` before this
 * handler runs. Per CLAUDE.md the handler does not call a section limiter itself.
 * The per-turn *spend* ceiling is separate and lives on the agent row.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ForbiddenError } from '@/lib/api/errors';
import { sseResponse } from '@/lib/api/sse';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { RESPARKABLE_CHAT_AGENT_SLUGS } from '@/lib/framework/resparkable/agents';
import { RESPARKABLE_CONTEXT_TYPE } from '@/lib/framework/resparkable/context/type';
import { RESPARKABLE_SCHEDULE_SPACE_KEY } from '@/lib/framework/resparkable/repo/space-scope';
import {
  assertPositiveBalance,
  recordAgentSpend,
} from '@/lib/framework/resparkable/services/billing';
import { ensureResparkableSpace } from '@/lib/framework/resparkable/services/space';
import { resparkableChatRequestSchema } from '@/lib/framework/resparkable/validations';
import { logger } from '@/lib/logging';
import { getRequestId, getVisitorId } from '@/lib/logging/context';
import { streamChat } from '@/lib/orchestration/chat';
import type { ChatEvent } from '@/types/orchestration';

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, resparkableChatRequestSchema);

  if (!RESPARKABLE_CHAT_AGENT_SLUGS.includes(body.agentSlug)) {
    // Deliberately the same answer for "not an Resparkable agent" and "an Resparkable
    // agent you may not drive from a browser". Naming which would tell a caller
    // the write-capable slugs exist.
    throw new ForbiddenError('That agent cannot be used from here');
  }

  // A chat turn can be someone's very first interaction with the brain, and
  // every scoped table has an FK to the space row. Idempotent and race-safe.
  await ensureResparkableSpace(session.user.id);

  const scope = await requestSpaceScope(request, session.user.id);
  // Refused before any provider call: see services/billing.ts. Throws
  // InsufficientCreditsError, turned into a 402 by withAuth's error handler.
  await assertPositiveBalance(scope);

  const [requestId, visitorId] = await Promise.all([getRequestId(), getVisitorId()]);

  log.info('Resparkable chat stream started', {
    agentSlug: body.agentSlug,
    conversationId: body.conversationId,
  });

  const events = streamChat({
    message: body.message,
    agentSlug: body.agentSlug,
    userId: session.user.id,
    ...(body.conversationId ? { conversationId: body.conversationId } : {}),
    // Both pinned. See the header — `contextId` is the field that would leak.
    contextType: RESPARKABLE_CONTEXT_TYPE,
    contextId: scope.spaceId,
    // The workspace, again, on the carrier that reaches a capability's
    // `CapabilityContext`. A hint by core's rules and re-resolved by the tier's,
    // so a turn's tools read the same brain its context block describes.
    scope: { [RESPARKABLE_SCHEDULE_SPACE_KEY]: scope.spaceId },
    ...(body.entityContext ? { entityContext: body.entityContext } : {}),
    requestId,
    ...(visitorId ? { visitorId } : {}),
    // No `includeTrace`: the trace strip carries raw tool arguments, which for
    // this tier means the user's own note text echoed back through a different
    // surface with different redaction. The admin route is where that belongs.
    signal: request.signal,
  });

  return sseResponse(tapChatSpend(events, scope), { signal: request.signal });
});

/**
 * Forwards every event unchanged. Captures `conversationId` off the `start`
 * event, and on `done` (per-turn `costUsd`/`tokenUsage`, computed by
 * `streaming-handler.ts`) writes the agent-spend ledger entry.
 *
 * A failed ledger write must never surface as a stream error. The chat
 * response has already been shown to the user by the time `done` arrives, so
 * this logs and keeps yielding rather than throwing into `sseResponse`'s
 * iteration.
 */
async function* tapChatSpend(
  events: AsyncIterable<ChatEvent>,
  scope: SpaceScope
): AsyncGenerator<ChatEvent> {
  let conversationId: string | undefined;

  for await (const event of events) {
    if (event.type === 'start') {
      conversationId = event.conversationId;
    } else if (event.type === 'done') {
      try {
        await recordAgentSpend(scope, {
          tokenCostUsd: event.costUsd,
          ...(conversationId ? { relatedConversationId: conversationId } : {}),
        });
      } catch (error) {
        logger.error('Resparkable chat spend could not be recorded', error, {
          spaceId: scope.spaceId,
          conversationId,
        });
      }
    }
    yield event;
  }
}
import { requestSpaceScope } from '@/lib/framework/resparkable/api/space-request';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
