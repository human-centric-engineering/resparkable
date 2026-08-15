/**
 * `resparkable_get_context_digest` — the deterministic gather step for the
 * description-summariser workflow.
 *
 * Not bound to any chat-reachable agent (see `resparkable-summariser` in
 * `agents.ts`): the workflow's `gather_digest` step calls it directly, the
 * same way the morning briefing's `gather_inputs` step calls
 * `resparkable_get_briefing_inputs` rather than leaving the model to fetch its
 * own inputs — a step that always runs is easier to reason about than a tool
 * call the model might skip.
 */

import {
  ResparkableCapability,
  auditArgsKeepShape,
} from '@/lib/framework/resparkable/capabilities/base';
import {
  resparkableCapabilitySpec,
  RESPARKABLE_CAPABILITY_SLUGS,
} from '@/lib/framework/resparkable/capabilities/catalogue';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  buildContextDigest,
  type ContextDigest,
} from '@/lib/framework/resparkable/services/context-digest';
import {
  resparkableEntityContextSchema,
  type ResparkableEntityContext,
} from '@/lib/framework/resparkable/validations';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

const spec = resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.getContextDigest);

export class ResparkableGetContextDigestCapability extends ResparkableCapability<
  ResparkableEntityContext,
  ContextDigest
> {
  readonly slug = spec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = spec.functionDefinition;
  protected readonly schema = resparkableEntityContextSchema;

  /**
   * `notes` is the user's own captured prose, already inside the erasure
   * cascade via `ResparkableThought`. The args (which item, how many notes) are
   * the useful audit trail; the content itself gets the same treatment
   * `resparkable_get_briefing_inputs` gives the resurfaced thought.
   */
  redactProvenance(
    args: ResparkableEntityContext,
    result: CapabilityResult<ContextDigest>
  ): ProvenanceRedaction {
    return auditArgsKeepShape(
      args,
      `context digest: ${result.data?.notes.length ?? 0} linked notes`
    );
  }

  protected async run(
    args: ResparkableEntityContext,
    scope: OwnerScope
  ): Promise<CapabilityResult<ContextDigest>> {
    const digest = await buildContextDigest(scope, args.entityType, args.entityId);
    if (!digest) {
      return this.error('No item with that id. It may have been deleted.', 'not_found');
    }
    return this.success(digest);
  }
}
