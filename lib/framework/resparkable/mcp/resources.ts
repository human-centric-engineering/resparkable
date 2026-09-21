/**
 * The brain as MCP **resources**: `resparkable://today` and
 * `resparkable://project/{slug}`.
 *
 * A resource is the cheaper shape for a read. The client attaches its content
 * to the conversation itself, where a tool call costs a round trip and a
 * decision by the model to make it. `exposure.ts` holds the argument for why
 * these two reads and no others.
 *
 * ## This is the first Resparkable MCP code, and here is what needed writing
 *
 * The tool path needed none: `protocol-handler.ts` folds the key's owner and
 * its scope carrier into `CapabilityContext`, and every Resparkable capability
 * already resolves a workspace from exactly that (`capabilities/base.ts`). The
 * resource path hands a handler `ResourceCallContext`, which carries the
 * owner and the key id but **not** the scope carrier, and it runs no guards.
 * So the three things the capability base class and
 * `refuseUnusableResparkableScope` do between them have to happen here
 * too, in the same order and with the same answers:
 *
 *   1. no owner, no read;
 *   2. a scope carrier this tier cannot read is refused rather than ignored;
 *   3. the workspace is re-resolved through membership on every call.
 *
 * {@link resolveResourceScope} is that, once, for both handlers. A third
 * resource added later gets it by calling the same function, which is why it
 * is a function rather than three lines copied into each handler.
 *
 * ## Why this reads the key row again
 *
 * `ResourceCallContext` has no `scope`. Core validated the carrier during
 * authentication and passed it to the tool path, then dropped it on the way to
 * a resource handler. `readKeyScope()` fetches it back: one primary-key lookup,
 * and it lives in `mcp/keys.ts` because that is the module holding this tier's
 * Prisma exemption for `McpApiKey` (`lib/framework/eslint.config.mjs`), which
 * is why nothing here imports `prisma`. The alternative to the lookup is a core
 * change that every upstream merge would have to carry. If core ever forwards
 * the carrier, this is the thing to delete.
 *
 * ## Errors come back as content, not as throws
 *
 * `readMcpResource` catches a throw and returns "Resource handler error" with
 * no detail, which is the opposite of what a person holding a mis-scoped key
 * needs. So a refusal is a normal return carrying the same message the tool
 * path would have given, and the client shows it.
 */

import { logger } from '@/lib/logging';
import {
  RESPARKABLE_MCP_RESOURCE_TYPES,
  RESPARKABLE_MCP_RESOURCES,
  type ResparkableMcpResourceType,
} from '@/lib/framework/resparkable/mcp/exposure';
import { unusableScopeReason } from '@/lib/framework/resparkable/mcp/key-scope';
import { readKeyScope } from '@/lib/framework/resparkable/mcp/keys';
import { findProjectBySlug } from '@/lib/framework/resparkable/repo/projects';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { buildProjectView } from '@/lib/framework/resparkable/services/details';
import { resolveActiveSpaceScope } from '@/lib/framework/resparkable/services/membership';
import { buildToday } from '@/lib/framework/resparkable/services/today';
import { registerMcpResourceHandler } from '@/lib/orchestration/mcp/resource-registry';
import type { ResourceCallContext } from '@/lib/orchestration/mcp/resource-registry';
import type { McpResourceContent } from '@/types/mcp';

/** The scheme these URIs use. The platform's own, named rather than inherited. */
const URI_SCHEME = 'resparkable';

/** The one URI the dashboard answers to. */
const TODAY_URI = 'resparkable://today';

/** Everything after this prefix in a project URI is the slug. */
const PROJECT_URI_PREFIX = 'resparkable://project/';

/**
 * The shape `services/slug.ts` produces, plus room for the disambiguating
 * suffix it appends. Checked before the query so a client probing with a path
 * traversal or a hundred-character string gets an answer without touching the
 * database.
 */
const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** A resolved workspace, or the reason there is not one. */
type ScopeResolution = { ok: true; scope: SpaceScope } | { ok: false; message: string };

/**
 * The owner, the workspace, and the refusals in between.
 *
 * Deliberately the same three answers `refuseUnusableResparkableScope`
 * and `requireResparkableSpace()` give the tool path. A resource that resolved
 * a workspace differently would be a second door into one brain with its own
 * rules about which brain, and the only way to find out they had drifted would
 * be a capture landing somewhere nobody was watching.
 */
async function resolveResourceScope(callContext: ResourceCallContext): Promise<ScopeResolution> {
  // `createdBy` is null for a key whose creator has been erased. The key still
  // authenticates, and there is no longer a brain behind it.
  if (!callContext.userId) {
    return {
      ok: false,
      message:
        'This resource reads one person’s notes, and the key that asked for it has no owner. Generate a new key from Settings.',
    };
  }

  const classification = await readKeyScope(callContext.apiKeyId);

  // Revoked between authentication and this read. Refusing rather than treating
  // a missing row as an absent carrier: `unscoped` would quietly succeed
  // against the person's default workspace.
  if (!classification) {
    return { ok: false, message: 'This key no longer exists. Generate a new one from Settings.' };
  }

  if (classification.kind === 'unusable') {
    return { ok: false, message: unusableScopeReason(classification) };
  }

  const target = classification.kind === 'scoped' ? classification.spaceId : null;
  const scope = await resolveActiveSpaceScope(callContext.userId, target);

  // Membership is re-read on every call, so a key stops reaching a group
  // workspace the moment its owner leaves it. Same refusal as a space that
  // never existed: a distinct message would confirm the workspace is real to
  // somebody holding a key that cannot reach it.
  if (!scope) {
    return {
      ok: false,
      message:
        'This key names a workspace it cannot reach. Generate a new key from Settings for the workspace you want.',
    };
  }

  return { ok: true, scope };
}

/** A JSON body, which is what both of these resources declare. */
function json(uri: string, payload: unknown): McpResourceContent {
  return { uri, mimeType: 'application/json', text: JSON.stringify(payload) };
}

/** A refusal or a miss, in the shape core's own handlers use for one. */
function problem(uri: string, message: string): McpResourceContent {
  return json(uri, { error: message });
}

/**
 * `resparkable://today`: the Today page's payload, unchanged.
 *
 * `buildToday` is the same function `GET /api/v1/resparkable/today` serves, so
 * an assistant reading this resource and a person looking at the dashboard are
 * looking at one ranking rather than two implementations of it.
 */
export async function handleResparkableToday(
  uri: string,
  _config: Record<string, unknown> | null,
  callContext: ResourceCallContext
): Promise<McpResourceContent> {
  // Core's prefix match is looser than an exact lookup, so this handler is
  // reached by `resparkable://todayish` too. Answering it would echo a real
  // payload back under a URI that is not a resource, which a client is entitled
  // to cache or subscribe to.
  if (uri !== TODAY_URI) {
    return problem(uri, `Read today's dashboard as ${TODAY_URI}.`);
  }

  const resolved = await resolveResourceScope(callContext);
  if (!resolved.ok) return problem(uri, resolved.message);

  return json(uri, await buildToday(resolved.scope));
}

/**
 * `resparkable://project/{slug}`: one project, by the slug in its own URL.
 *
 * A slug naming a project in somebody else's workspace is indistinguishable
 * from a typo, which is §16.2's rule for every read in this tier: a 403 would
 * confirm the project exists to whoever guessed the name.
 */
export async function handleResparkableProject(
  uri: string,
  _config: Record<string, unknown> | null,
  callContext: ResourceCallContext
): Promise<McpResourceContent> {
  const slug = projectSlugFrom(uri);
  if (!slug) {
    return problem(
      uri,
      `Read a project as ${PROJECT_URI_PREFIX}<slug>. Read ${TODAY_URI} first if you do not have a slug: every task there carries its project's.`
    );
  }

  const resolved = await resolveResourceScope(callContext);
  if (!resolved.ok) return problem(uri, resolved.message);

  const project = await findProjectBySlug(resolved.scope, slug);
  if (!project) return problem(uri, `No project with the slug "${slug}".`);

  const payload = await buildProjectView(resolved.scope, project.id);
  // Only reachable if the row was deleted between the two queries.
  if (!payload) return problem(uri, `No project with the slug "${slug}".`);

  return json(uri, payload);
}

/**
 * The slug in a project URI, or null if this is not one.
 *
 * Strict about the tail even though the registry is not: core's prefix match
 * hands this handler `resparkable://project/a/b` and a URI with a query string
 * as readily as a bare slug, and `findProjectBySlug` would answer "no project"
 * for all of them. Parsing them out here means the message says what the URI
 * should look like instead.
 */
function projectSlugFrom(uri: string): string | null {
  if (!uri.startsWith(PROJECT_URI_PREFIX)) return null;

  const tail = uri.slice(PROJECT_URI_PREFIX.length);
  let slug: string;
  try {
    slug = decodeURIComponent(tail);
  } catch {
    // A lone `%` in the tail. Malformed rather than missing.
    return null;
  }

  return SLUG_SHAPE.test(slug) ? slug : null;
}

/**
 * Handler per resource type, exhaustive by construction.
 *
 * `Record<ResparkableMcpResourceType, …>` rather than a map built from the
 * manifest: adding a row to `RESPARKABLE_MCP_RESOURCES` without writing its
 * handler then fails type-check here, rather than seeding a row that lists to
 * every client and answers "no handler for type" on first read.
 */
const HANDLERS: Record<
  ResparkableMcpResourceType,
  (
    uri: string,
    config: Record<string, unknown> | null,
    callContext: ResourceCallContext
  ) => Promise<McpResourceContent>
> = {
  [RESPARKABLE_MCP_RESOURCE_TYPES.today]: handleResparkableToday,
  [RESPARKABLE_MCP_RESOURCE_TYPES.project]: handleResparkableProject,
};

/**
 * Register both handlers. Called from `lib/app/mcp-resources.ts`.
 *
 * Driven off the manifest so the registration and the seeded rows cannot name
 * different types: whatever `006-mcp` writes into `resourceType` is what gets a
 * handler here, and `resources.test.ts` asserts the two lists match.
 *
 * Cheap and synchronous, like the capability registration: core runs it lazily
 * before the first resource read, and a registration that queried the database
 * would put that query in front of every one.
 */
export function registerResparkableMcpResources(): void {
  for (const resource of RESPARKABLE_MCP_RESOURCES) {
    registerMcpResourceHandler({
      resourceType: resource.resourceType,
      uriScheme: URI_SCHEME,
      handler: HANDLERS[resource.resourceType],
    });
  }

  logger.debug('Resparkable MCP resources registered', {
    count: RESPARKABLE_MCP_RESOURCES.length,
  });
}
