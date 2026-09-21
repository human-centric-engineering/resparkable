/**
 * A person's own MCP key for one workspace: mint it, rotate it, revoke it.
 *
 * Everything an assistant needs to reach someone's brain over MCP already
 * exists. What did not, until this file, is a way for a **person** to get a
 * key: minting lived behind `withAdminAuth`, and since a key acts as its
 * creator, an admin had to sign in as you to connect your assistant. On any
 * install with more than one person that does not happen.
 *
 * The rules are all here rather than in the routes, so they can be read in one
 * place and tested without HTTP. The routes resolve a workspace, refuse an
 * API-key session, and call one of these four functions.
 *
 * ## The person chooses nothing
 *
 * This is the safety argument for the whole surface, and it is worth stating
 * before the code: a self-service credential is safe because every field on it
 * is forced or derived. The caller sends **no body at all**.
 *
 * | Property | Value                                                                 |
 * | -------- | --------------------------------------------------------------------- |
 * | Count    | One live key per person per workspace. A second is refused             |
 * | Name     | Derived, `"<person> · <workspace>"`. Never asked for                   |
 * | Scope    | Forced to the canonical space id, resolved through membership          |
 * | Scopes   | Forced to the three below                                             |
 * | Expiry   | None written, so a non-null `expiresAt` came from an admin             |
 * | Agent    | `scopedAgentId` left null: it narrows nothing (see `mcp.md`'s gotcha) |
 *
 * ## Why this file may import Prisma when the rest of the tier may not
 *
 * `lib/framework/eslint.config.mjs` lets only `repo/**` and `access/**` reach
 * the database, because every **brain** query is a space query or a shared
 * query and a stray `prisma` import is how an unscoped third kind gets written.
 * This file is named in the same exemption list as `db-drift.ts`, and for the
 * same reason that one is: it is not a brain query.
 *
 * `McpApiKey` is a core-owned table with no `spaceId` column, so no `SpaceScope`
 * can filter it and `spaceWhere()` has nothing to spread into. Putting it in
 * `repo/**` would mean writing the first repo function whose `where` is keyed
 * on the **actor**, which is precisely what §23.2 spends a paragraph forbidding
 * and what `isolation.test.ts` asserts against: the moment an actor is a filter
 * in that layer, a group space has a per-row ACL. A credential list is the one
 * thing an actor legitimately filters, and it does not belong in the layer
 * built on the opposite premise.
 *
 * `keys-boundary.test.ts` holds the exemption to exactly that: this file may
 * reach `mcpApiKey` and nothing else. Widening it to a brain table fails there
 * rather than in review.
 *
 * ## Org binding is deliberately not here yet
 *
 * Sunrise 0.13 adds `McpApiKey.orgId` and refuses a key whose org is suspended.
 * That column does not exist in this tree: it is on upstream main, untagged,
 * beside in-flight tenancy work. When it lands, {@link mintConnectionKey} gains
 * `orgId: orgForMint()` on the create and {@link rotateConnectionKey} keeps not
 * touching it, matching core's own mint and rotate routes. Nothing else here
 * changes. Until then Resparkable runs single-tenant, where a null org reads as
 * the install org.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  classifyStoredKeyScope,
  type ResparkableKeyScope,
} from '@/lib/framework/resparkable/mcp/key-scope';
import {
  RESPARKABLE_SCHEDULE_SPACE_KEY,
  type SpaceScope,
} from '@/lib/framework/resparkable/repo/space-scope';
import { listOpenableSpaces } from '@/lib/framework/resparkable/services/spaces';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { generateApiKey } from '@/lib/orchestration/mcp/auth';
import { getMcpServerConfig } from '@/lib/orchestration/mcp/config';

import { McpScope } from '@/types/mcp';

/**
 * The three protocol scopes every one of these keys carries, and the only ones.
 *
 * `resources:read` is absent. Core's MCP resources include
 * `resparkable://knowledge/search`, which an unscoped key runs system-wide, and
 * a key minted from a settings page should not carry a grant nobody asked for.
 *
 * `prompts:read` is present, and it is the one departure from the Hub's pair.
 * Resparkable's three MCP prompts, `resparkable-capture` above all, are part of
 * what a person is connecting an assistant **for**. The cost is that core's own
 * seeded prompts come with them and will appear in the holder's slash menu:
 * templates, not data, so this is noise rather than exposure.
 */
export const CONNECTION_KEY_SCOPES: string[] = [
  McpScope.TOOLS_LIST,
  McpScope.TOOLS_EXECUTE,
  McpScope.PROMPTS_READ,
];

/** What a caller gets back about a key that already exists. Never a secret. */
export interface ConnectionKeySummary {
  id: string;
  /** The first twelve characters, which is what the admin list shows too. */
  keyPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** A freshly minted or rotated key. The plaintext exists here and never again. */
export interface MintedConnectionKey extends ConnectionKeySummary {
  plaintext: string;
}

/** What the card reads on load. */
export interface ConnectionKeysView {
  /**
   * `McpServerConfig.isEnabled`. False by default on every install, and a key
   * minted against a server that is off cannot connect, so the card says so
   * rather than letting somebody debug a client config for twenty minutes.
   */
  serverEnabled: boolean;
  /**
   * **Every** live key for this workspace, not the first.
   *
   * One per workspace is a rule this file enforces read-then-write, not a
   * database constraint, and an admin reactivating an old row leaves two.
   * Rendering `keys[0]` would hide a working credential from the person holding
   * it, which is the one thing a credential list must never do.
   */
  keys: ConnectionKeySummary[];
}

/**
 * Why an operation was refused.
 *
 * `no_such_key` is deliberately the answer to every kind of miss: another
 * person's key, an admin's unscoped service key, a key for a different
 * workspace, a key that is dead. One answer, so the route confirms nothing
 * about keys that are not the caller's.
 */
export type ConnectionKeyRefusal = 'server_disabled' | 'already_exists' | 'no_such_key';

export type ConnectionKeyResult<T> =
  { ok: true; value: T } | { ok: false; reason: ConnectionKeyRefusal };

/**
 * Which keys are usable right now, as a `where` fragment.
 *
 * **One expression of the rule, every reader**, and that is the whole point.
 * An admin revokes two ways, `isActive: false` or a past `expiresAt`, and MCP
 * auth rejects both. A member surface that checked only one would show a key
 * that cannot connect, and would let Regenerate write fresh secret material
 * onto a dead row and report success. All four readers here (the cap, the list,
 * rotate and revoke) reach the database through `liveKeysFor`, so they get this
 * fragment and cannot disagree about what "live" means.
 *
 * A `where` fragment rather than a predicate, because the narrowing belongs in
 * the query: nothing here ever holds a dead row to ask about. An earlier draft
 * had both, an exported `isLiveKey()` beside this, and nothing called the
 * predicate. Two encodings of one rule is precisely the drift this rule exists
 * to prevent, so the unused one went.
 */
function liveKeyWhere(now: Date): { isActive: true; OR: Array<Record<string, unknown>> } {
  return { isActive: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

/**
 * The label the admin keys page renders for one of these.
 *
 * Derived, never asked for and never shown on the card: a name is a field a
 * person would have to think about, and thinking about it is not part of
 * connecting an assistant. The separator is a middle dot rather than a dash so
 * a workspace called "Q3 - planning" still reads as one name.
 */
export function connectionKeyName(personName: string, spaceName: string): string {
  return `${personName} · ${spaceName}`;
}

/** The row shape every read here selects. No hash ever leaves this file. */
const KEY_SELECT = {
  id: true,
  keyPrefix: true,
  scope: true,
  isActive: true,
  expiresAt: true,
  createdAt: true,
  lastUsedAt: true,
} as const;

interface KeyRow {
  id: string;
  keyPrefix: string;
  scope: unknown;
  isActive: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/**
 * The scope carrier on one key by id, classified the way this tier reads it.
 * `null` when there is no such row.
 *
 * Here rather than in the caller because of the exemption above: reading
 * `McpApiKey` is this file's job, and `mcp/resources.ts` is the caller that
 * needs it. Core folds a key's carrier into `CapabilityContext` for a
 * `tools/call` and drops it on the way to a resource handler, so the resource
 * path has to fetch it back before it can refuse a carrier it cannot read.
 *
 * Liveness is not checked, and deliberately: this answers "what does this key
 * say", not "may it act". Authentication settled the second question before any
 * caller got here, and re-answering it in a second place is how two definitions
 * of a dead key start to disagree.
 */
export async function readKeyScope(apiKeyId: string): Promise<ResparkableKeyScope | null> {
  const row = await prisma.mcpApiKey.findUnique({
    where: { id: apiKeyId },
    select: { scope: true },
  });

  return row ? classifyStoredKeyScope(row.scope) : null;
}

/** Is this row one of *this person's* keys for *this* workspace? */
function belongsToWorkspace(row: KeyRow, spaceId: string): boolean {
  const classification = classifyStoredKeyScope(row.scope);
  return classification.kind === 'scoped' && classification.spaceId === spaceId;
}

function summarise(row: KeyRow): ConnectionKeySummary {
  return {
    id: row.id,
    keyPrefix: row.keyPrefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

/**
 * The live keys this person holds for this workspace.
 *
 * Narrowed in the database by creator and liveness, then filtered in memory by
 * {@link belongsToWorkspace}. The second half is in memory on purpose: it makes
 * `classifyResparkableKeyScope` the **single** definition of "scoped to this
 * workspace" in the tier, rather than adding a Prisma JSON-path filter that
 * would be a second, subtly looser one (a path match accepts a carrier with
 * extra keys; the classifier does not). The set is at most a handful of rows,
 * because that is what one key per workspace means.
 */
async function liveKeysFor(scope: SpaceScope, actorUserId: string): Promise<KeyRow[]> {
  const rows = await prisma.mcpApiKey.findMany({
    where: { createdBy: actorUserId, ...liveKeyWhere(new Date()) },
    select: KEY_SELECT,
    orderBy: { createdAt: 'asc' },
  });

  return rows.filter((row) => belongsToWorkspace(row, scope.spaceId));
}

/**
 * The actor behind a scope, which every function here requires.
 *
 * `SpaceScope.actorUserId` is nullable because an anonymous public-link reader
 * has no account. Such a reader cannot reach these routes at all (they are
 * behind `withAuth`), so this is a shape the type allows and the code path
 * does not, and it throws rather than reading `createdBy: null` and matching
 * every orphaned key in the install.
 */
function actorOf(scope: SpaceScope): string {
  if (!scope.actorUserId) {
    throw new Error('An MCP connection key requires a named actor');
  }
  return scope.actorUserId;
}

/**
 * What this workspace is called, for the derived key name.
 *
 * Through `listOpenableSpaces`, which already knows that a personal space with
 * no name of its own is "Personal" and that a group space is named by its
 * group. Re-deriving either here would be a second answer to a question that
 * already has one, and the switcher's answer is the one the person has been
 * reading all along.
 *
 * Falls back rather than throwing. The scope was resolved through membership a
 * moment ago, so a miss means a workspace vanished between two queries, and
 * failing a mint over the *label* on a key would be the wrong end of that
 * problem to care about.
 */
async function spaceNameFor(scope: SpaceScope, actorUserId: string): Promise<string> {
  const spaces = await listOpenableSpaces(actorUserId);
  return spaces.find((space) => space.spaceId === scope.spaceId)?.name ?? 'Workspace';
}

/**
 * What the Connect card reads on load.
 *
 * Reports the server switch even when there are no keys, because "you have no
 * key" and "this install has the MCP server switched off" are different
 * problems with different fixes, and only one of them is the person's to solve.
 */
export async function readConnectionKeys(scope: SpaceScope): Promise<ConnectionKeysView> {
  const [config, rows] = await Promise.all([
    getMcpServerConfig(),
    liveKeysFor(scope, actorOf(scope)),
  ]);

  return { serverEnabled: config.isEnabled, keys: rows.map(summarise) };
}

/**
 * Mint this person's key for this workspace.
 *
 * Refuses when a live one already exists: regenerate or revoke it instead. A
 * **dead** row does not count, and is left exactly where it is. It is the
 * record of an admin's revocation, and deleting it to make room would erase
 * that decision while looking like housekeeping.
 */
export async function mintConnectionKey(
  scope: SpaceScope,
  input: { personName: string; clientIp?: string }
): Promise<ConnectionKeyResult<MintedConnectionKey>> {
  const actorUserId = actorOf(scope);

  const config = await getMcpServerConfig();
  if (!config.isEnabled) return { ok: false, reason: 'server_disabled' };

  const existing = await liveKeysFor(scope, actorUserId);
  if (existing.length > 0) return { ok: false, reason: 'already_exists' };

  // Resolved here rather than passed in by the route, so "the name is derived,
  // never asked for" is one rule in one place. The route has no business
  // knowing how a key is labelled, and a second caller would otherwise have to
  // rediscover the convention.
  const name = connectionKeyName(input.personName, await spaceNameFor(scope, actorUserId));

  const { plaintext, hash, prefix } = generateApiKey();

  const row = await prisma.mcpApiKey.create({
    data: {
      name,
      keyHash: hash,
      keyPrefix: prefix,
      scopes: CONNECTION_KEY_SCOPES,
      // The canonical space id off the resolved scope, which membership
      // produced. Never a slug, never a route param read straight through, and
      // never a body field: there is no body.
      scope: { [RESPARKABLE_SCHEDULE_SPACE_KEY]: scope.spaceId },
      // Left null, both of them, and both deliberately. An expiry a person
      // cannot see coming is a credential that stops working mid-sentence; a
      // scoped agent narrows nothing (`mcp.md`, "The gotcha, first") while
      // reading as though it does.
      expiresAt: null,
      scopedAgentId: null,
      createdBy: actorUserId,
    },
    select: KEY_SELECT,
  });

  logger.info('Resparkable connection key minted', {
    userId: actorUserId,
    spaceId: scope.spaceId,
    keyId: row.id,
  });

  // Recorded in the same admin audit log as admin-minted keys, and with the
  // same entity type, so "who has a key to this install" is one query rather
  // than two.
  logAdminAction({
    userId: actorUserId,
    action: 'mcp_api_key.create',
    entityType: 'mcp_api_key',
    entityId: row.id,
    entityName: name,
    metadata: { keyPrefix: row.keyPrefix, scopes: CONNECTION_KEY_SCOPES, selfService: true },
    ...(input.clientIp ? { clientIp: input.clientIp } : {}),
  });

  return { ok: true, value: { ...summarise(row), plaintext } };
}

/**
 * Fresh secret material on the same row. The old key stops working at once.
 *
 * **Does not reactivate a deactivated key, and does not clear an expiry.**
 * Either would let a person undo an administrator's decision from their own
 * settings page, which is not what a Regenerate button is for. A dead key is
 * not found here at all, so the card offers Generate instead and a new row is
 * minted beside the old one.
 */
export async function rotateConnectionKey(
  scope: SpaceScope,
  keyId: string,
  options: { clientIp?: string } = {}
): Promise<ConnectionKeyResult<MintedConnectionKey>> {
  const actorUserId = actorOf(scope);

  const live = await liveKeysFor(scope, actorUserId);
  const target = live.find((row) => row.id === keyId);
  if (!target) return { ok: false, reason: 'no_such_key' };

  const { plaintext, hash, prefix } = generateApiKey();

  const row = await prisma.mcpApiKey.update({
    where: { id: target.id },
    // Key material only. `isActive`, `expiresAt`, `scope` and `orgId` are all
    // absent from this object on purpose: rotation replaces a secret, it does
    // not re-decide anything about the key.
    data: { keyHash: hash, keyPrefix: prefix },
    select: KEY_SELECT,
  });

  logger.info('Resparkable connection key rotated', {
    userId: actorUserId,
    spaceId: scope.spaceId,
    keyId: row.id,
  });

  logAdminAction({
    userId: actorUserId,
    action: 'mcp_api_key.rotate',
    entityType: 'mcp_api_key',
    entityId: row.id,
    metadata: { previousPrefix: target.keyPrefix, newPrefix: row.keyPrefix, selfService: true },
    ...(options.clientIp ? { clientIp: options.clientIp } : {}),
  });

  return { ok: true, value: { ...summarise(row), plaintext } };
}

/**
 * Delete the row.
 *
 * A person revoking their own credential wants it gone, not deactivated: they
 * have no admin surface on which to see a deactivated row, so leaving one would
 * be retaining a record they cannot read. This is the opposite decision from
 * the dead-row rule in {@link mintConnectionKey}, and for the same reason: what
 * is kept is an administrator's decision, and this one is the holder's.
 */
export async function revokeConnectionKey(
  scope: SpaceScope,
  keyId: string,
  options: { clientIp?: string } = {}
): Promise<ConnectionKeyResult<{ id: string }>> {
  const actorUserId = actorOf(scope);

  const live = await liveKeysFor(scope, actorUserId);
  const target = live.find((row) => row.id === keyId);
  if (!target) return { ok: false, reason: 'no_such_key' };

  await prisma.mcpApiKey.delete({ where: { id: target.id } });

  logger.info('Resparkable connection key revoked', {
    userId: actorUserId,
    spaceId: scope.spaceId,
    keyId: target.id,
  });

  logAdminAction({
    userId: actorUserId,
    action: 'mcp_api_key.delete',
    entityType: 'mcp_api_key',
    entityId: target.id,
    metadata: { keyPrefix: target.keyPrefix, selfService: true },
    ...(options.clientIp ? { clientIp: options.clientIp } : {}),
  });

  return { ok: true, value: { id: target.id } };
}
