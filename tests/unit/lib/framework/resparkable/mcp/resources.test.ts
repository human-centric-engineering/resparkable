/**
 * Unit Tests: the two MCP resources, and the guard work the resource path does
 * not do for them.
 *
 * **A resource is a second front door to one person's brain, and core opens it
 * differently from the first.** `tools/call` arrives with the key's owner and
 * its scope carrier folded into `CapabilityContext`, runs
 * `refuseUnusableResparkableScope`, and resolves a workspace through
 * `requireResparkableSpace()`. `resources/read` runs none of that: it hands a
 * handler the owner and the key id, and calls it. So every refusal the tool
 * path gives has to be asserted here independently, because there is no shared
 * code between the two that a single test could cover both through.
 *
 * The one that matters most is the mis-scoped key. `key-scope.ts` exists
 * because a carrier Resparkable cannot read used to fall through to the
 * person's default workspace, which reads as working and answers about the
 * wrong brain. A resource handler that classified that carrier differently
 * would reopen exactly that hole through the other door.
 *
 * Test Coverage:
 * - Every manifest row registers a handler, under the platform's own scheme
 * - A URI and its `resourceType` are a valid pair, which core checks at create
 * - A key with no owner reads nothing, and does not reach the database
 * - A revoked key is refused rather than read as unscoped
 * - An unusable scope carrier is refused, naming the key to use
 * - A workspace the holder is not in is refused, and says nothing about it
 * - A scoped carrier resolves through membership; an empty one takes the default
 * - Project URIs are parsed strictly, decoded, and missed identically
 * - Each handler answers its own URI only, not every prefix match core sends
 * - Both handlers call the guard, not just the one the refusals are asserted on
 *
 * @see lib/framework/resparkable/mcp/resources.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mcpApiKey, logger } = vi.hoisted(() => ({
  mcpApiKey: { findUnique: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({ prisma: { mcpApiKey } }));
vi.mock('@/lib/logging', () => ({ logger }));

vi.mock('@/lib/framework/resparkable/services/membership', () => ({
  resolveActiveSpaceScope: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/today', () => ({ buildToday: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/details', () => ({ buildProjectView: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/projects', () => ({ findProjectBySlug: vi.fn() }));

import {
  RESPARKABLE_MCP_RESOURCE_TYPES,
  RESPARKABLE_MCP_RESOURCES,
} from '@/lib/framework/resparkable/mcp/exposure';
import {
  handleResparkableProject,
  handleResparkableToday,
  registerResparkableMcpResources,
} from '@/lib/framework/resparkable/mcp/resources';
import { findProjectBySlug } from '@/lib/framework/resparkable/repo/projects';
import {
  RESPARKABLE_SCHEDULE_SPACE_KEY,
  spaceScope,
  spaceScopeFor,
} from '@/lib/framework/resparkable/repo/space-scope';
import { buildProjectView } from '@/lib/framework/resparkable/services/details';
import { resolveActiveSpaceScope } from '@/lib/framework/resparkable/services/membership';
import { buildToday } from '@/lib/framework/resparkable/services/today';
import {
  __resetAppMcpResourcesForTests,
  isDispatchableMcpResourceType,
  isUriSchemeValidForResourceType,
  mcpResourceUriSchemeFor,
} from '@/lib/orchestration/mcp/resource-registry';
import type { ResourceCallContext } from '@/lib/orchestration/mcp/resource-registry';

const OWNER = 'user_a';
const SPACE_ID = 'spc_group_alpha';
const TODAY_URI = 'resparkable://today';

/** The call context core builds for a key minted from the Connect card. */
function callContext(overrides: Partial<ResourceCallContext> = {}): ResourceCallContext {
  return { scopedAgentId: null, apiKeyId: 'key_1', userId: OWNER, ...overrides };
}

/** Whatever a handler returned, as the object a client would parse. */
function body(content: { text: string }): Record<string, unknown> {
  return JSON.parse(content.text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAppMcpResourcesForTests();
  mcpApiKey.findUnique.mockResolvedValue({ scope: null });
  vi.mocked(resolveActiveSpaceScope).mockResolvedValue(spaceScope(OWNER));
  vi.mocked(buildToday).mockResolvedValue({ tasks: [], inboxCount: 0 } as never);
});

describe('registration', () => {
  it('reaches the registry through the app seam, with nothing called by hand', () => {
    // The registrations are wired from `lib/app/mcp-resources.ts`, which core
    // runs itself before the first read. Asserting through the registry rather
    // than by calling `registerResparkableMcpResources()` here is the point:
    // the seam being connected is the thing that can silently not be.
    for (const resource of RESPARKABLE_MCP_RESOURCES) {
      expect(isDispatchableMcpResourceType(resource.resourceType)).toBe(true);
      expect(mcpResourceUriSchemeFor(resource.resourceType)).toBe('resparkable');
    }
  });

  it('is idempotent, because core may run the init again after a reset', () => {
    registerResparkableMcpResources();
    registerResparkableMcpResources();

    for (const resource of RESPARKABLE_MCP_RESOURCES) {
      expect(isDispatchableMcpResourceType(resource.resourceType)).toBe(true);
    }
  });

  it('files every URI under the scheme its own type is registered with', () => {
    // Core checks these as a PAIR when the row is created, so a manifest URI
    // whose scheme is not the registered one is a row the admin API refuses
    // and the seed would fail on.
    registerResparkableMcpResources();

    for (const resource of RESPARKABLE_MCP_RESOURCES) {
      expect(
        isUriSchemeValidForResourceType(resource.uri, resource.resourceType),
        resource.uri
      ).toBe(true);
    }
  });
});

describe('who is asking', () => {
  it('reads nothing for a key whose creator has been erased', async () => {
    const content = await handleResparkableToday(TODAY_URI, null, callContext({ userId: null }));

    expect(body(content).error).toContain('no owner');
    // The refusal is decided before anything is loaded: an erased owner has no
    // workspace to look one up in.
    expect(mcpApiKey.findUnique).not.toHaveBeenCalled();
    expect(buildToday).not.toHaveBeenCalled();
  });

  it('refuses a key revoked between authentication and this read', async () => {
    mcpApiKey.findUnique.mockResolvedValue(null);

    const content = await handleResparkableToday(TODAY_URI, null, callContext());

    // The dangerous alternative is reading `scope` off nothing, classifying it
    // as unscoped, and answering about the person's default workspace.
    expect(body(content).error).toContain('no longer exists');
    expect(buildToday).not.toHaveBeenCalled();
  });

  it('refuses a scope carrier this tier cannot read, and names the key to use', async () => {
    mcpApiKey.findUnique.mockResolvedValue({ scope: { spaceId: SPACE_ID } });

    const content = await handleResparkableToday(TODAY_URI, null, callContext());

    const error = String(body(content).error);
    expect(error).toContain('"spaceId"');
    expect(error).toContain(RESPARKABLE_SCHEDULE_SPACE_KEY);
    // Names the offending key, never its value: the value could be somebody
    // else's workspace id, and this message goes to whoever holds the key.
    expect(error).not.toContain(SPACE_ID);
    expect(resolveActiveSpaceScope).not.toHaveBeenCalled();
    expect(buildToday).not.toHaveBeenCalled();
  });

  it('refuses a workspace the holder is not in, without confirming it exists', async () => {
    mcpApiKey.findUnique.mockResolvedValue({
      scope: { [RESPARKABLE_SCHEDULE_SPACE_KEY]: SPACE_ID },
    });
    vi.mocked(resolveActiveSpaceScope).mockResolvedValue(null);

    const content = await handleResparkableToday(TODAY_URI, null, callContext());

    expect(body(content).error).toContain('cannot reach');
    expect(body(content).error).not.toContain(SPACE_ID);
    expect(buildToday).not.toHaveBeenCalled();
  });

  it('resolves the named workspace through membership on every call', async () => {
    const groupScope = spaceScopeFor({ spaceId: SPACE_ID, actorUserId: OWNER, role: 'member' });
    mcpApiKey.findUnique.mockResolvedValue({
      scope: { [RESPARKABLE_SCHEDULE_SPACE_KEY]: SPACE_ID },
    });
    vi.mocked(resolveActiveSpaceScope).mockResolvedValue(groupScope);

    await handleResparkableToday(TODAY_URI, null, callContext());

    expect(resolveActiveSpaceScope).toHaveBeenCalledWith(OWNER, SPACE_ID);
    expect(buildToday).toHaveBeenCalledWith(groupScope);
  });

  it('takes the default workspace for a key carrying no scope at all', async () => {
    mcpApiKey.findUnique.mockResolvedValue({ scope: {} });

    await handleResparkableToday(TODAY_URI, null, callContext());

    // Unscoped stays usable: it is what every admin-minted service key has
    // carried since before this tier had workspaces.
    expect(resolveActiveSpaceScope).toHaveBeenCalledWith(OWNER, null);
  });
});

describe('resparkable://today', () => {
  it('answers only its own URI, not everything core’s prefix match sends it', async () => {
    // `resparkable://todayish` reaches this handler through the prefix test.
    // Echoing a real payload back under it would hand a client something it can
    // cache or subscribe to that is not a resource.
    const content = await handleResparkableToday('resparkable://todayish', null, callContext());

    expect(body(content).error).toContain(TODAY_URI);
    expect(buildToday).not.toHaveBeenCalled();
  });

  it('returns the dashboard payload as JSON, under the URI it was asked for', async () => {
    vi.mocked(buildToday).mockResolvedValue({ tasks: [{ id: 'tsk_1' }], inboxCount: 3 } as never);

    const content = await handleResparkableToday(TODAY_URI, null, callContext());

    expect(content.uri).toBe(TODAY_URI);
    expect(content.mimeType).toBe('application/json');
    expect(body(content)).toEqual({ tasks: [{ id: 'tsk_1' }], inboxCount: 3 });
  });
});

describe('resparkable://project/{slug}', () => {
  const view = { project: { id: 'prj_1', slug: 'ship-the-thing' }, tasks: [] };

  beforeEach(() => {
    vi.mocked(findProjectBySlug).mockResolvedValue({ id: 'prj_1' } as never);
    vi.mocked(buildProjectView).mockResolvedValue(view as never);
  });

  it('looks the project up by slug and builds the view from its id', async () => {
    const uri = 'resparkable://project/ship-the-thing';

    const content = await handleResparkableProject(uri, null, callContext());

    expect(findProjectBySlug).toHaveBeenCalledWith(spaceScope(OWNER), 'ship-the-thing');
    expect(buildProjectView).toHaveBeenCalledWith(spaceScope(OWNER), 'prj_1');
    expect(body(content)).toEqual(view);
  });

  it('decodes a percent-encoded slug', async () => {
    await handleResparkableProject('resparkable://project/ship%2Dthe%2Dthing', null, callContext());

    expect(findProjectBySlug).toHaveBeenCalledWith(spaceScope(OWNER), 'ship-the-thing');
  });

  it('answers a slug in nobody’s workspace exactly like a typo', async () => {
    vi.mocked(findProjectBySlug).mockResolvedValue(null);

    const content = await handleResparkableProject(
      'resparkable://project/somebody-elses',
      null,
      callContext()
    );

    expect(body(content).error).toBe('No project with the slug "somebody-elses".');
    expect(buildProjectView).not.toHaveBeenCalled();
  });

  it.each([
    ['an extra path segment', 'resparkable://project/one/two'],
    ['a traversal attempt', 'resparkable://project/../today'],
    ['a query string', 'resparkable://project/ship?format=csv'],
    ['an empty slug', 'resparkable://project/'],
    ['a malformed escape', 'resparkable://project/%zz'],
    ['the wrong resource entirely', 'resparkable://today'],
  ])('rejects %s before it reaches the database', async (_label, uri) => {
    const content = await handleResparkableProject(uri, null, callContext());

    // Core's prefix match is looser than the template, so these reach the
    // handler. Saying what the URI should look like beats "no project".
    expect(body(content).error).toContain('resparkable://project/<slug>');
    expect(mcpApiKey.findUnique).not.toHaveBeenCalled();
    expect(findProjectBySlug).not.toHaveBeenCalled();
  });

  it('runs the same guard the today resource does, before it looks anything up', async () => {
    // The refusals above are all asserted through `handleResparkableToday`,
    // and the two handlers share no code beyond the call to
    // `resolveResourceScope`. So this asserts the call itself: without it a
    // mis-scoped key would read this resource against its holder's default
    // workspace, and every other test in this file would still pass.
    mcpApiKey.findUnique.mockResolvedValue({ scope: { spaceId: SPACE_ID } });

    const content = await handleResparkableProject(
      'resparkable://project/ship-the-thing',
      null,
      callContext()
    );

    expect(String(body(content).error)).toContain(RESPARKABLE_SCHEDULE_SPACE_KEY);
    expect(findProjectBySlug).not.toHaveBeenCalled();
    expect(buildProjectView).not.toHaveBeenCalled();
  });

  it('is the row the seed writes as a template', () => {
    const row = RESPARKABLE_MCP_RESOURCES.find(
      (r) => r.resourceType === RESPARKABLE_MCP_RESOURCE_TYPES.project
    );

    // `listMcpResourceTemplates()` filters on the placeholder, so a URI without
    // one would list as a concrete resource a client could only read literally.
    expect(row?.uri).toBe('resparkable://project/{slug}');
  });
});
