/**
 * Unit Tests: every Resparkable capability carries the key-scope guard.
 *
 * A sweep rather than a case per capability, for the reason `scope.test.ts`
 * gives about the owner-scope guard: the failure worth catching is not "someone
 * wrote the guard wrong", it is "someone added a twenty-fourth capability and
 * it registered without one". No per-class test catches that, because the
 * missing test is the one nobody wrote.
 *
 * What a gap would cost: a capability registered bare is a capability a
 * mis-scoped MCP key still reaches, and reaches in the holder's default
 * workspace. The other twenty-three would refuse the same key, so the hole
 * would be one tool wide and completely silent. That is the shape of gap that
 * survives review, which is why it is asserted instead.
 *
 * The assertion runs over `resparkableCapabilityRegistrations()`, the list the
 * registration loop consumes verbatim, rather than over a mocked registry. The
 * options are the thing under test, and reading them as data beats intercepting
 * the call that passes them along.
 *
 * Test Coverage:
 * - Every registration carries a guard, and it is this tier's guard
 * - The roster registered matches the roster built, so neither list can drift
 * - The list is non-empty, so none of the above can pass vacuously
 * - The guard, as registered, actually refuses a mis-scoped key
 *
 * @see lib/framework/resparkable/capabilities/index.ts
 * @see lib/framework/resparkable/mcp/key-scope.ts
 */

import { describe, it, expect } from 'vitest';

import {
  resparkableCapabilityHandlers,
  resparkableCapabilityRegistrations,
} from '@/lib/framework/resparkable/capabilities';
import { refuseUnusableResparkableScope } from '@/lib/framework/resparkable/mcp/key-scope';
import { platformScope } from '@/lib/orchestration/scope';

describe('resparkableCapabilityRegistrations', () => {
  it('covers every handler the tier builds, and nothing else', () => {
    // The two lists come from the same array today, and this holds them to it.
    // A registration list that was ever hand-maintained beside the handler
    // array would drift into a capability registered twice, or one registered
    // never, and neither announces itself at runtime.
    const registered = resparkableCapabilityRegistrations()
      .map(({ capability }) => capability.slug)
      .sort();
    const built = resparkableCapabilityHandlers()
      .map((capability) => capability.slug)
      .sort();

    expect(registered).toEqual(built);
  });

  it('registers a roster at all, so the sweeps below cannot pass on an empty list', () => {
    // Every other assertion in this file is a filter over the roster, and a
    // filter over nothing passes. This is the line that makes them mean
    // something.
    expect(resparkableCapabilityRegistrations().length).toBeGreaterThan(20);
  });

  it('attaches the key-scope guard to every single one', () => {
    const bare = resparkableCapabilityRegistrations()
      .filter(({ options }) => options.guard !== refuseUnusableResparkableScope)
      .map(({ capability }) => capability.slug);

    // Named rather than counted: a failure should say which capability is
    // exposed, not that a number changed.
    expect(bare).toEqual([]);
  });

  it('attaches a guard that actually refuses a mis-scoped key', () => {
    // Identity against the exported guard proves the wiring; this proves the
    // thing wired in does the job. Without it, exporting a permissive stub
    // under the same name would satisfy every assertion above.
    for (const { capability, options } of resparkableCapabilityRegistrations()) {
      const decision = options.guard?.({
        userId: 'usr_holder',
        agentId: 'agt_mcp_system',
        ...platformScope({ spaceId: 'spc_wrong_key_name' }),
      });

      expect(decision, `${capability.slug} did not refuse a mis-scoped key`).toMatchObject({
        allow: false,
      });
    }
  });
});
