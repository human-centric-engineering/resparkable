/**
 * `resparkable_get_group_digest_inputs`: the deterministic gather step for a
 * group's weekly digest (§23.8, phase 50).
 *
 * Bound only to `resparkable-digester`, which is not chat-reachable; the
 * digest workflow's `gather_inputs` step calls it directly, the same way the
 * morning briefing gathers before its one model call. What it returns carries
 * no authorship, which is half of why the digest cannot rank members: see
 * `services/group-digest.ts`.
 *
 * Refuses in a personal space. The digest is a group artefact.
 */

import {
  ResparkableCapability,
  auditArgsKeepShape,
} from '@/lib/framework/resparkable/capabilities/base';
import {
  resparkableCapabilitySpec,
  RESPARKABLE_CAPABILITY_SLUGS,
} from '@/lib/framework/resparkable/capabilities/catalogue';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import {
  buildGroupDigestInputs,
  NotAGroupSpaceError,
  type GroupDigestInputs,
} from '@/lib/framework/resparkable/services/group-digest';
import {
  agentGroupDigestInputsSchema,
  type AgentGroupDigestInputsInput,
} from '@/lib/framework/resparkable/validations';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

const spec = resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.getGroupDigestInputs);

export class ResparkableGetGroupDigestInputsCapability extends ResparkableCapability<
  AgentGroupDigestInputsInput,
  GroupDigestInputs
> {
  readonly slug = spec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = spec.functionDefinition;
  protected readonly schema = agentGroupDigestInputsSchema;

  /**
   * The result is titles of the group's own rows, which is exactly what
   * `redactProvenance` keeps out of `AiMessage.provenance`, outside the erasure
   * cascade. The args are empty by construction.
   */
  redactProvenance(
    args: AgentGroupDigestInputsInput,
    _result: CapabilityResult<GroupDigestInputs>
  ): ProvenanceRedaction {
    return auditArgsKeepShape(args, 'group digest inputs: a week of titles, no authorship');
  }

  protected async run(
    _args: AgentGroupDigestInputsInput,
    scope: SpaceScope
  ): Promise<CapabilityResult<GroupDigestInputs>> {
    try {
      return this.success(await buildGroupDigestInputs(scope));
    } catch (error) {
      if (error instanceof NotAGroupSpaceError) {
        return this.error(error.message, 'not_a_group_space');
      }
      throw error;
    }
  }
}
