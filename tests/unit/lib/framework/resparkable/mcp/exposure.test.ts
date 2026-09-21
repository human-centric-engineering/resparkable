/**
 * Unit Tests: the MCP exposure manifest.
 *
 * **The list is the access control, so the list gets a test.**
 * `McpApiKey.scopedAgentId` looks like it narrows a key to the bound agent's
 * capabilities, and it does not — `listMcpTools()` scoping drops only
 * capabilities with an explicit `isEnabled: false` binding row, and Resparkable's
 * bindings work by absence. So whatever is enabled here is reachable by every
 * key, and "we scoped the key to the companion" is not the safety net it reads
 * as. These assertions are the actual one.
 *
 * The same reasoning as `004-agent-capabilities`, where the judge's zero
 * bindings are asserted rather than assumed: the failure mode is someone adding
 * "just one more useful tool" and quietly handing an MCP client the ability to
 * restructure a person's goals.
 *
 * Test Coverage:
 * - Every exposed slug is a real capability, and no slug is exposed twice
 * - `resparkable_capture` is the only write on the surface
 * - Every withheld capability is absent, with its reason recorded beside it
 * - The catalogue is exactly the manifest plus `WITHHELD`, so a capability
 *   added later cannot be absent by default instead of by decision
 * - Read annotations agree with the capability's own `isIdempotent`
 * - Prompt names, argument names and templates satisfy core's validation
 * - Every tool a prompt tells a client to call is a tool this manifest exposes
 *
 * @see lib/framework/resparkable/mcp/exposure.ts
 */

import { describe, expect, it } from 'vitest';

import {
  RESPARKABLE_CAPABILITIES,
  RESPARKABLE_CAPABILITY_SLUGS,
  resparkableCapabilitySpec,
} from '@/lib/framework/resparkable/capabilities/catalogue';
import {
  RESPARKABLE_MCP_PROMPTS,
  RESPARKABLE_MCP_RESOURCES,
  RESPARKABLE_MCP_TOOLS,
} from '@/lib/framework/resparkable/mcp/exposure';
import { McpResourceType } from '@/types/mcp';

const exposedSlugs = RESPARKABLE_MCP_TOOLS.map((t) => t.slug);
const exposed = new Set<string>(exposedSlugs);

const S = RESPARKABLE_CAPABILITY_SLUGS;

/**
 * Every capability that stays off the MCP surface, and why.
 *
 * **This is the half of the access control that is not in `exposure.ts`.** The
 * manifest says what a client can reach; nothing in it says what was considered
 * and refused, so a capability added later is absent by default and nobody has
 * to notice. The test below turns that default into a failure: the catalogue
 * must be exactly this map plus the manifest, so a new capability cannot land
 * without somebody writing one of these lines or adding a tool.
 *
 * The reasons are the point. Three groups:
 *
 * - **Structure writes.** Creating or reshaping a project, goal, area, entity,
 *   task, time block or link is the person's own decision about the shape of
 *   their work. It changes what the scorer surfaces tomorrow, and an MCP client
 *   is the one caller with no UI in which to notice that it happened.
 * - **Workflow plumbing.** Deterministic gather steps that mean nothing outside
 *   the workflow that calls them.
 * - **Capture doors that are not the capture door.** `resparkable_capture` is
 *   the single write on the surface. The other two are bound to one agent each
 *   and carry their own trust arguments; see `capture-channels.md`.
 */
const WITHHELD: Record<string, string> = {
  [S.upsertProject]: 'structure is the owner’s decision, not a client’s',
  [S.upsertGoal]: 'structure is the owner’s decision, not a client’s',
  [S.upsertArea]: 'structure is the owner’s decision, not a client’s',
  [S.upsertEntity]: 'structure is the owner’s decision, not a client’s',
  [S.upsertTask]: 'structure is the owner’s decision, not a client’s',
  [S.upsertTimeBlock]: 'structure is the owner’s decision, not a client’s',
  [S.linkEntities]: 'structure is the owner’s decision, not a client’s',
  [S.promoteThought]: 'filing an inbox item is the review ritual, not a tool call',
  [S.writeReview]: 'the weekly review is the prompt’s job, and the person writes it',
  [S.reprioritise]: 'it rewrites tomorrow’s ranking, invisibly to a client',
  [S.getBriefingInputs]: 'plumbing for the briefing workflow, meaningless outside it',
  [S.getContextDigest]: 'plumbing for the description summariser, meaningless outside it',
  [S.notify]: 'plumbing for the briefing workflow, meaningless outside it',
  [S.captureContext]:
    'a second capture door, bound to the resparkable-context agent and shaped for its conversation',
  [S.captureForToken]:
    'the email intake door, bound to the intake agent and trusted only through a token',
};

describe('Resparkable MCP tool exposure', () => {
  it('exposes only capabilities that exist, each exactly once', () => {
    const known = new Set(RESPARKABLE_CAPABILITIES.map((c) => c.slug));
    for (const slug of exposedSlugs) {
      expect(known.has(slug), `${slug} is not in the capability catalogue`).toBe(true);
    }
    expect(exposed.size).toBe(exposedSlugs.length);
  });

  it('puts exactly one write on the surface, and it is capture', () => {
    const writes = RESPARKABLE_MCP_TOOLS.filter((t) => !t.readOnlyHint).map((t) => t.slug);
    expect(writes).toEqual([RESPARKABLE_CAPABILITY_SLUGS.capture]);
  });

  it.each(Object.entries(WITHHELD))('does not expose %s: %s', (slug) => {
    expect(exposed.has(slug)).toBe(false);
  });

  it('accounts for every capability in the catalogue, exposed or withheld', () => {
    // The assertion the individually-named list above was reaching for and
    // could not make. Typing the withheld slugs out by hand asserted only what
    // somebody remembered to type: five capabilities added after this manifest
    // (`upsert_area`, `upsert_time_block`, `capture_context`,
    // `get_context_digest`, `capture_for_token`) were in neither list, so the
    // guard whose comment promised a new one "has to be considered rather than
    // inherited" was silently inheriting them. This makes that impossible —
    // a new capability fails here until it is exposed or given a reason.
    const accounted = new Set([...exposed, ...Object.keys(WITHHELD)]);
    const unaccounted = RESPARKABLE_CAPABILITIES.map((c) => c.slug).filter(
      (slug) => !accounted.has(slug)
    );

    expect(
      unaccounted,
      'add it to RESPARKABLE_MCP_TOOLS, or to WITHHELD with the reason it stays off'
    ).toEqual([]);
  });

  it('withholds nothing it also exposes', () => {
    // The other direction: a slug promoted into the manifest but left in
    // WITHHELD would make the `it.each` above fail, but only once somebody ran
    // it. Naming the overlap says which slug, rather than which case.
    const both = Object.keys(WITHHELD).filter((slug) => exposed.has(slug));

    expect(both).toEqual([]);
  });

  it('marks every read-only tool as one the capability itself considers safe to repeat', () => {
    // `resparkable_ideate` is the deliberate exception: a pure read that bills an
    // LLM call, so the capability is `isIdempotent: false` on purpose. Any
    // OTHER read-only tool that is not idempotent means the two files disagree
    // about what the tool does.
    for (const tool of RESPARKABLE_MCP_TOOLS) {
      if (!tool.readOnlyHint) continue;
      if (tool.slug === RESPARKABLE_CAPABILITY_SLUGS.ideate) continue;
      expect(resparkableCapabilitySpec(tool.slug).isIdempotent, `${tool.slug}`).toBe(true);
    }
  });

  it('claims nothing destroys data and nothing reaches an open world', () => {
    for (const tool of RESPARKABLE_MCP_TOOLS) {
      expect(tool.destructiveHint, `${tool.slug} destructiveHint`).toBe(false);
      expect(tool.openWorldHint, `${tool.slug} openWorldHint`).toBe(false);
    }
  });

  it('gives every tool a title and a stated reason for being on the list', () => {
    for (const tool of RESPARKABLE_MCP_TOOLS) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.rationale.length).toBeGreaterThan(20);
    }
  });
});

describe('Resparkable MCP resources', () => {
  it('writes rows core will accept, uniquely', () => {
    // Same limits as `createExposedResourceSchema`, which the admin route
    // enforces and the seed bypasses. A row over one of these would seed fine
    // and then be uneditable in the admin UI.
    const uris = RESPARKABLE_MCP_RESOURCES.map((r) => r.uri);
    for (const resource of RESPARKABLE_MCP_RESOURCES) {
      expect(resource.uri).toMatch(/^[a-z][a-z0-9+.-]*:\/\/.+/);
      expect(resource.uri.length).toBeLessThanOrEqual(500);
      expect(resource.uri).toBe(resource.uri.toLowerCase());
      expect(resource.name.length).toBeGreaterThan(0);
      expect(resource.name.length).toBeLessThanOrEqual(100);
      expect(resource.description.length).toBeGreaterThan(0);
      expect(resource.description.length).toBeLessThanOrEqual(5000);
      expect(resource.mimeType.length).toBeGreaterThan(0);
      expect(resource.rationale.length).toBeGreaterThan(20);
    }
    expect(new Set(uris).size).toBe(uris.length);
  });

  it('files each row under a type of its own, never one of core’s', () => {
    // `registerMcpResourceHandler` refuses to override a built-in and logs
    // rather than throwing, so a collision here would leave the row seeded,
    // listed, and answering with core's data instead of the brain's.
    const builtIn = new Set<string>(Object.values(McpResourceType));
    const types = RESPARKABLE_MCP_RESOURCES.map((r) => r.resourceType);

    for (const type of types) {
      expect(type).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(builtIn.has(type), `${type} shadows a core resource type`).toBe(false);
    }
    expect(new Set(types).size).toBe(types.length);
  });

  it('keeps every URI under the platform’s own scheme', () => {
    // Registered as `resparkable` in `mcp/resources.ts`, and core checks the
    // scheme against the type as a pair. A row under any other scheme is one
    // the registry will not dispatch.
    for (const resource of RESPARKABLE_MCP_RESOURCES) {
      expect(resource.uri.startsWith('resparkable://')).toBe(true);
    }
  });
});

describe('Resparkable MCP prompts', () => {
  it('uses names core will accept, uniquely', () => {
    const names = RESPARKABLE_MCP_PROMPTS.map((p) => p.name);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_-]*$/);
      expect(name.length).toBeLessThanOrEqual(64);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps templates and argument specs inside core’s limits', () => {
    for (const prompt of RESPARKABLE_MCP_PROMPTS) {
      expect(prompt.template.length).toBeLessThanOrEqual(10_000);
      expect(prompt.description.length).toBeGreaterThan(0);
      expect(prompt.argumentsSpec.length).toBeLessThanOrEqual(20);
      for (const arg of prompt.argumentsSpec) {
        expect(arg.name).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(arg.description.length).toBeGreaterThan(0);
        expect(arg.description.length).toBeLessThanOrEqual(500);
      }
    }
  });

  it('declares every placeholder it substitutes', () => {
    // Core renders an undeclared `{{var}}` literally — that is the security
    // boundary that stops `{{database_url}}`. It also means a typo in a
    // declared name ships as visible braces in the user's message rather than
    // as an error.
    for (const prompt of RESPARKABLE_MCP_PROMPTS) {
      const declared = new Set(prompt.argumentsSpec.map((a) => a.name));
      const used = [...prompt.template.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi)].map((m) =>
        m[1].toLowerCase()
      );
      for (const name of used) {
        expect(declared.has(name), `${prompt.name} uses undeclared {{${name}}}`).toBe(true);
      }
      for (const name of declared) {
        expect(used).toContain(name);
      }
    }
  });

  it('only tells clients to call tools this manifest actually exposes', () => {
    // A prompt naming an unexposed tool is a slash command that half works:
    // the client sees the instruction, `tools/list` does not offer the tool,
    // and the model improvises.
    for (const prompt of RESPARKABLE_MCP_PROMPTS) {
      const named = [...prompt.template.matchAll(/\bresparkable_[a-z_]+/g)].map((m) => m[0]);
      expect(named.length, `${prompt.name} names no tools`).toBeGreaterThan(0);
      for (const slug of named) {
        expect(exposed.has(slug), `${prompt.name} names unexposed ${slug}`).toBe(true);
      }
    }
  });
});
