/**
 * `resparkable_capture_context` — the capture door for a "tell me more"
 * conversation, bound only to the resparkable-context agent
 * (RESPARKABLE_AGENT_SLUGS.context).
 *
 * Two things distinguish this from `resparkable_capture`:
 *
 *   - **`source` is pinned to `'chat'`**, the value `THOUGHT_SOURCES` has
 *     carried since phase 6 but that nothing has set until now — a
 *     first-person distillation of a conversation, not a verbatim capture and
 *     not the companion's own paraphrase (`'agent'`). Same trust-boundary
 *     rule as `capture.ts`: never an argument, always pinned server-side.
 *   - **It reads `context.entityContext` rather than an argument.** The
 *     anchor — "this conversation is about Project X" — is set by the page
 *     the user opened, the same way `context.userId` is set by the session
 *     rather than typed. `resparkableEntityContextSchema` (validations.ts) is
 *     the one shape both the chat route and this capability trust; a
 *     malformed or absent context is not an error, it just means no link gets
 *     created — the freeform surface has no entity to anchor to at all.
 *
 * When the anchor resolves, this calls the same `linkEntities` service
 * `resparkable_link_entities` and `POST /resparkable/links` already call —
 * ownership of the target is verified there (`entityExists`), so a stale or
 * cross-user id degrades to "no link" rather than an error, identical to any
 * other dangling-endpoint case in this tier.
 */

import { ResparkableCapability, maskFreeText } from '@/lib/framework/resparkable/capabilities/base';
import {
  resparkableCapabilitySpec,
  RESPARKABLE_CAPABILITY_SLUGS,
} from '@/lib/framework/resparkable/capabilities/catalogue';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { captureThought } from '@/lib/framework/resparkable/services/capture';
import { linkEntities } from '@/lib/framework/resparkable/services/links';
import {
  agentCaptureContextSchema,
  resparkableEntityContextSchema,
  type AgentCaptureContextInput,
} from '@/lib/framework/resparkable/validations';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

const spec = resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.captureContext);

interface CaptureContextData {
  id: string;
  /** True when an `externalId` replay returned the original row (never happens here — no externalId — kept for shape parity with `resparkable_capture`'s result). */
  deduped: boolean;
  capturedAt: string;
  linkedTo: { entityType: string; entityId: string } | null;
}

export class ResparkableCaptureContextCapability extends ResparkableCapability<
  AgentCaptureContextInput,
  CaptureContextData
> {
  readonly slug = spec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = spec.functionDefinition;
  protected readonly schema = agentCaptureContextSchema;

  /** Same reasoning as `capture.ts`: the content is the user's own prose about their life, and a second permanent copy on the audit row would sit outside the erasure cascade. */
  redactProvenance(
    args: AgentCaptureContextInput,
    result: CapabilityResult<CaptureContextData>
  ): ProvenanceRedaction {
    return {
      args: maskFreeText(args, ['content']),
      resultPreview: JSON.stringify(result),
    };
  }

  protected async run(
    args: AgentCaptureContextInput,
    scope: SpaceScope,
    context: CapabilityContext
  ): Promise<CapabilityResult<CaptureContextData>> {
    const { thought, deduped } = await captureThought(scope, {
      content: args.content,
      // Pinned, never argued. See the file header.
      source: 'chat',
    });

    const anchor = resparkableEntityContextSchema.safeParse(context.entityContext);
    let linkedTo: CaptureContextData['linkedTo'] = null;

    if (anchor.success) {
      const link = await linkEntities(scope, {
        sourceType: 'thought',
        sourceId: thought.id,
        targetType: anchor.data.entityType,
        targetId: anchor.data.entityId,
        kind: 'relates_to',
      });
      if (link) linkedTo = { entityType: anchor.data.entityType, entityId: anchor.data.entityId };
    }

    return this.success({
      id: thought.id,
      deduped,
      capturedAt: thought.createdAt.toISOString(),
      linkedTo,
    });
  }
}
