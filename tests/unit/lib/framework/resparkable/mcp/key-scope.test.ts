/**
 * Unit Tests: how this tier reads an MCP key's scope carrier, and who the guard
 * lets past.
 *
 * Two populations arrive at this guard carrying an authoritative scope, and
 * they look nothing alike. An MCP key carries one key. A scheduled run carries
 * the schedule's own keys, both spellings of the owner among them, because the
 * phase 45 migration wrote `resparkableSpaceId` **alongside** the legacy
 * `resparkableUserId` rather than replacing it
 * (`20260829120000_resparkable_space_key/migration.sql`). So every migrated
 * schedule row in every install carries a carrier that classifies as unusable,
 * and a guard that classified it would stop every 04:30 briefing at once.
 *
 * That is why the scheduled-run cases below are built from the real carrier
 * shape rather than a plausible one, and why they are in the same file as the
 * classification cases: the two halves of this guard are one decision, and a
 * later edit that tightens the first without reading the second is exactly the
 * failure worth spending a test file on.
 *
 * Test Coverage:
 * - An absent, null or empty carrier is unscoped, and passes
 * - The one shape a person's key may carry is scoped, and passes
 * - A wrong key name is unusable, and the refusal names the key to use
 * - The right key beside a wrong one is unusable, not scoped
 * - The right key carrying nothing is unusable, not silently unscoped
 * - A real scheduled-run carrier passes untouched, both keys and all
 * - A chat turn's hint is not classified, because it is not authoritative
 * - No refusal message contains a scope value
 *
 * @see lib/framework/resparkable/mcp/key-scope.ts
 */

import { describe, it, expect } from 'vitest';

import {
  classifyResparkableKeyScope,
  refuseUnusableResparkableScope,
  unusableScopeReason,
} from '@/lib/framework/resparkable/mcp/key-scope';
import {
  RESPARKABLE_SCHEDULE_OWNER_KEY,
  RESPARKABLE_SCHEDULE_SPACE_KEY,
} from '@/lib/framework/resparkable/repo/space-scope';
import { platformScope, hintScope } from '@/lib/orchestration/scope';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const SPACE_ID = 'spc_group_alpha';

/**
 * The context an MCP tool call arrives with, built the way `callMcpTool` builds
 * it: the key's creator as the actor, no workflow execution, and the carrier
 * spread through `platformScope` because `McpApiKey.scope` is admin-written.
 */
function mcpContext(scope: Record<string, string> | undefined): CapabilityContext {
  return {
    userId: 'usr_holder',
    agentId: 'agt_mcp_system',
    ...platformScope(scope),
  };
}

/**
 * The context a scheduled run arrives with, built the way the `tool_call`
 * executor builds it: system-owned since resparkable#502, a synthetic agent
 * label, the execution id that makes it unattended, and the schedule's own
 * authoritative carrier.
 */
function scheduledRunContext(scope: Record<string, string>): CapabilityContext {
  return {
    userId: null,
    agentId: 'workflow:resparkable-daily-briefing',
    workflowExecutionId: 'exec_0430',
    ...platformScope(scope),
  };
}

describe('classifyResparkableKeyScope', () => {
  it('reads an absent carrier as unscoped', () => {
    expect(classifyResparkableKeyScope(undefined)).toEqual({ kind: 'unscoped' });
    expect(classifyResparkableKeyScope(null)).toEqual({ kind: 'unscoped' });
  });

  it('reads an empty carrier as unscoped, the same as none at all', () => {
    // An admin who cleared the field and one who never set it made the same
    // decision, and a key that acts in the person's default workspace is the
    // documented unscoped behaviour rather than a degraded one.
    expect(classifyResparkableKeyScope({})).toEqual({ kind: 'unscoped' });
  });

  it('reads the one permitted shape as scoped, and hands back the space', () => {
    expect(classifyResparkableKeyScope({ [RESPARKABLE_SCHEDULE_SPACE_KEY]: SPACE_ID })).toEqual({
      kind: 'scoped',
      spaceId: SPACE_ID,
    });
  });

  it('refuses a plausible wrong key name rather than falling through to the default workspace', () => {
    // This is the whole reason the module exists. `spaceId` is what somebody
    // would type from memory, and `requireResparkableSpace()` does not read it:
    // before this guard the key worked, and wrote into whichever workspace
    // happened to be the holder's default.
    expect(classifyResparkableKeyScope({ spaceId: SPACE_ID })).toEqual({
      kind: 'unusable',
      unknownKeys: ['spaceId'],
    });
  });

  it('refuses the legacy owner key, which this tier does not read on a key', () => {
    // `readResparkableScheduleSpaceId()` accepts it for schedule rows. Route 1
    // of `requireResparkableSpace()` deliberately does not, so a key carrying
    // only this resolves to the holder's default workspace: right by
    // coincidence on a one-workspace account, wrong the day they join a group.
    expect(classifyResparkableKeyScope({ [RESPARKABLE_SCHEDULE_OWNER_KEY]: 'usr_holder' })).toEqual(
      { kind: 'unusable', unknownKeys: [RESPARKABLE_SCHEDULE_OWNER_KEY] }
    );
  });

  it('refuses the right key when an inert one sits beside it', () => {
    // Not scoped, even though the space is readable. The extra key means the
    // minter believed it did something and the reader disagrees, which is the
    // disagreement worth surfacing.
    expect(
      classifyResparkableKeyScope({
        [RESPARKABLE_SCHEDULE_SPACE_KEY]: SPACE_ID,
        projectId: 'prj_1',
      })
    ).toEqual({ kind: 'unusable', unknownKeys: ['projectId'] });
  });

  it('names every unknown key, sorted, so the message is stable to read', () => {
    const result = classifyResparkableKeyScope({ zulu: '1', alpha: '2' });
    expect(result).toEqual({ kind: 'unusable', unknownKeys: ['alpha', 'zulu'] });
  });

  it('refuses the right key carrying an empty value rather than reading it as unscoped', () => {
    // An empty string passes `mcpKeyScopeSchema` and then resolves to no space
    // at all. Reading it as unscoped would send the key to the default
    // workspace, which is the silent failure in its least informative form.
    expect(classifyResparkableKeyScope({ [RESPARKABLE_SCHEDULE_SPACE_KEY]: '' })).toEqual({
      kind: 'unusable',
      unknownKeys: [],
    });
  });
});

describe('unusableScopeReason', () => {
  it('names the key to use and the keys that are wrong', () => {
    const message = unusableScopeReason({ kind: 'unusable', unknownKeys: ['spaceId'] });

    expect(message).toContain('"spaceId"');
    expect(message).toContain(RESPARKABLE_SCHEDULE_SPACE_KEY);
  });

  it('says what is wrong when the workspace is simply blank', () => {
    const message = unusableScopeReason({ kind: 'unusable', unknownKeys: [] });

    expect(message).toContain('blank');
    expect(message).toContain(RESPARKABLE_SCHEDULE_SPACE_KEY);
  });

  it('carries no scope value, because core folds the reason into a client message', () => {
    // The key names came off the holder's own credential. The values could name
    // somebody else's workspace, so they stay out of a message the holder's
    // client prints.
    const decision = refuseUnusableResparkableScope(
      mcpContext({ spaceId: SPACE_ID, [RESPARKABLE_SCHEDULE_OWNER_KEY]: 'usr_someone_else' })
    ) as { allow: false; reason: string };

    expect(decision.allow).toBe(false);
    expect(decision.reason).not.toContain(SPACE_ID);
    expect(decision.reason).not.toContain('usr_someone_else');
  });
});

describe('refuseUnusableResparkableScope: an MCP key', () => {
  it('allows an unscoped key', () => {
    expect(refuseUnusableResparkableScope(mcpContext(undefined))).toEqual({ allow: true });
  });

  it('allows a correctly scoped key', () => {
    expect(
      refuseUnusableResparkableScope(mcpContext({ [RESPARKABLE_SCHEDULE_SPACE_KEY]: SPACE_ID }))
    ).toEqual({ allow: true });
  });

  it('refuses an unusable carrier', () => {
    const decision = refuseUnusableResparkableScope(mcpContext({ spaceId: SPACE_ID }));

    expect(decision).toMatchObject({ allow: false });
  });
});

describe('refuseUnusableResparkableScope: a scheduled run', () => {
  // The carrier every schedule row in every migrated install actually holds.
  // Classified, it is unusable; that is what the passthrough is for.
  const REAL_SCHEDULE_SCOPE = {
    [RESPARKABLE_SCHEDULE_OWNER_KEY]: 'usr_owner',
    [RESPARKABLE_SCHEDULE_SPACE_KEY]: SPACE_ID,
  };

  it('is a carrier this tier would otherwise refuse', () => {
    // Stated as its own assertion rather than left implied: if a later change
    // made the migrated shape classify as scoped, the passthrough test below
    // would keep passing while proving nothing.
    expect(classifyResparkableKeyScope(REAL_SCHEDULE_SCOPE).kind).toBe('unusable');
  });

  it('passes untouched, both keys and all', () => {
    expect(refuseUnusableResparkableScope(scheduledRunContext(REAL_SCHEDULE_SCOPE))).toEqual({
      allow: true,
    });
  });

  it('passes on a pre-migration row carrying only the legacy key', () => {
    expect(
      refuseUnusableResparkableScope(
        scheduledRunContext({ [RESPARKABLE_SCHEDULE_OWNER_KEY]: 'usr_owner' })
      )
    ).toEqual({ allow: true });
  });

  it('passes on an org-level schedule whose scope names no workspace at all', () => {
    expect(refuseUnusableResparkableScope(scheduledRunContext({ tenantId: 'org_1' }))).toEqual({
      allow: true,
    });
  });
});

describe('refuseUnusableResparkableScope: a chat turn', () => {
  it('is not classified, because the carrier is a hint the person did not choose', () => {
    // `POST /api/v1/resparkable/chat/stream` routes the space through
    // `hintScope`, and `requireResparkableSpace()` already re-resolves it
    // against membership every turn. Classifying it here would refuse a live
    // turn over a value the person cannot correct.
    const turn: CapabilityContext = {
      userId: 'usr_holder',
      agentId: 'agt_companion',
      ...hintScope({ spaceId: SPACE_ID }),
    };

    expect(refuseUnusableResparkableScope(turn)).toEqual({ allow: true });
  });
});
