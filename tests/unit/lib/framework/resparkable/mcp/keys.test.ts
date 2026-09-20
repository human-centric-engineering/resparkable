/**
 * Unit Tests: the rules a person's own MCP key is minted, rotated and revoked by.
 *
 * The routes are thin on purpose, so this is where the decisions live and where
 * they are asserted. Three of them are worth naming, because each is a place
 * the obvious implementation is wrong:
 *
 *   • **A dead key is no key.** An admin revokes two ways, `isActive: false` or
 *     a past `expiresAt`, and MCP auth rejects both. A surface that checked one
 *     would show a key that cannot connect, and would let Regenerate write
 *     fresh secret material onto a dead row and report success.
 *   • **Regenerating undoes nothing an admin decided.** It replaces key
 *     material, and touches neither `isActive` nor `expiresAt`.
 *   • **Every miss is the same miss.** Another person's key, an admin's
 *     unscoped service key, a key for a different workspace: one answer, so the
 *     surface confirms nothing about keys that are not the caller's.
 *
 * Test Coverage:
 * - The server switch is reported, and a mint against a disabled server refuses
 * - One live key per workspace; a dead row does not count and is not deleted
 * - A deactivated or expired key is absent, and 404s on rotate and revoke
 * - Rotate writes key material only, and never reactivates or clears an expiry
 * - Another person's key, an unscoped key and another workspace's are all missed
 * - The minted row carries the forced scopes, the canonical space, null agent
 * - No returned summary or log line carries a plaintext key or a hash
 *
 * @see lib/framework/resparkable/mcp/keys.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// `vi.hoisted`, because `vi.mock` factories are lifted above every import and
// a plain `const` here would not exist yet when the factory runs.
const { mcpApiKey, logger } = vi.hoisted(() => ({
  mcpApiKey: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({ prisma: { mcpApiKey } }));
vi.mock('@/lib/logging', () => ({ logger }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));
vi.mock('@/lib/orchestration/mcp/config', () => ({ getMcpServerConfig: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/spaces', () => ({ listOpenableSpaces: vi.fn() }));

import {
  CONNECTION_KEY_SCOPES,
  connectionKeyName,
  mintConnectionKey,
  readConnectionKeys,
  revokeConnectionKey,
  rotateConnectionKey,
} from '@/lib/framework/resparkable/mcp/keys';
import {
  RESPARKABLE_SCHEDULE_SPACE_KEY,
  spaceScopeFor,
} from '@/lib/framework/resparkable/repo/space-scope';
import { listOpenableSpaces } from '@/lib/framework/resparkable/services/spaces';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getMcpServerConfig } from '@/lib/orchestration/mcp/config';

const ACTOR = 'user_a';
const SPACE_ID = 'spc_group_alpha';

const SCOPE = spaceScopeFor({ spaceId: SPACE_ID, actorUserId: ACTOR, role: 'member' });

/** A live key of this person's, for this workspace. */
function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key_1',
    keyPrefix: 'smcp_abcd12',
    scope: { [RESPARKABLE_SCHEDULE_SPACE_KEY]: SPACE_ID },
    isActive: true,
    expiresAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    lastUsedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMcpServerConfig).mockResolvedValue({ isEnabled: true } as never);
  vi.mocked(listOpenableSpaces).mockResolvedValue([
    { spaceId: SPACE_ID, name: 'Study Group B' },
  ] as never);
  mcpApiKey.findMany.mockResolvedValue([]);
  mcpApiKey.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve(keyRow({ id: 'key_new', keyPrefix: String(data.keyPrefix) }))
  );
  mcpApiKey.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve(keyRow({ keyPrefix: String(data.keyPrefix) }))
  );
  mcpApiKey.delete.mockResolvedValue(keyRow());
});

describe('readConnectionKeys', () => {
  it('reports the server switch even when there are no keys', async () => {
    vi.mocked(getMcpServerConfig).mockResolvedValue({ isEnabled: false } as never);

    // "You have no key" and "this install has the server off" are different
    // problems, and only one of them is the person's to solve.
    await expect(readConnectionKeys(SCOPE)).resolves.toEqual({ serverEnabled: false, keys: [] });
  });

  it('asks the database only for this person’s live keys, on both halves of the rule', async () => {
    await readConnectionKeys(SCOPE);

    const where = mcpApiKey.findMany.mock.calls[0][0].where;
    expect(where.createdBy).toBe(ACTOR);

    // Both halves, asserted together, because this fragment is now the only
    // expression of "live" in the tier. An admin revokes two ways and MCP auth
    // rejects both; a reader that checked `isActive` alone would offer
    // Regenerate on a key that expired last week.
    expect(where.isActive).toBe(true);
    expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
  });

  it('returns every live key for the workspace, not just the first', async () => {
    // One per workspace is a rule applied at mint, not a database constraint:
    // an admin reactivating an old row leaves two, and hiding one would hide a
    // working credential from the person holding it.
    mcpApiKey.findMany.mockResolvedValue([keyRow(), keyRow({ id: 'key_2' })]);

    const view = await readConnectionKeys(SCOPE);

    expect(view.keys.map((key) => key.id)).toEqual(['key_1', 'key_2']);
  });

  it('drops a key scoped to a different workspace', async () => {
    mcpApiKey.findMany.mockResolvedValue([
      keyRow(),
      keyRow({ id: 'key_elsewhere', scope: { [RESPARKABLE_SCHEDULE_SPACE_KEY]: 'spc_other' } }),
    ]);

    const view = await readConnectionKeys(SCOPE);

    expect(view.keys.map((key) => key.id)).toEqual(['key_1']);
  });

  it('drops an admin’s unscoped service key', async () => {
    // It is the organisation's, not this person's, and it does not belong on a
    // settings page offering a Revoke button.
    mcpApiKey.findMany.mockResolvedValue([keyRow({ id: 'key_service', scope: null })]);

    await expect(readConnectionKeys(SCOPE)).resolves.toMatchObject({ keys: [] });
  });

  it('drops a key whose carrier this tier cannot read', async () => {
    mcpApiKey.findMany.mockResolvedValue([keyRow({ id: 'key_odd', scope: { spaceId: SPACE_ID } })]);

    await expect(readConnectionKeys(SCOPE)).resolves.toMatchObject({ keys: [] });
  });

  it('never returns a hash or a plaintext', async () => {
    mcpApiKey.findMany.mockResolvedValue([keyRow()]);

    const view = await readConnectionKeys(SCOPE);

    expect(Object.keys(view.keys[0])).toEqual(['id', 'keyPrefix', 'createdAt', 'lastUsedAt']);
    // The select is the real guard: a hash cannot be leaked by a later field
    // addition if it was never read.
    expect(mcpApiKey.findMany.mock.calls[0][0].select.keyHash).toBeUndefined();
  });
});

describe('mintConnectionKey', () => {
  it('refuses when the MCP server is switched off', async () => {
    vi.mocked(getMcpServerConfig).mockResolvedValue({ isEnabled: false } as never);

    await expect(mintConnectionKey(SCOPE, { personName: 'Ada' })).resolves.toEqual({
      ok: false,
      reason: 'server_disabled',
    });
    expect(mcpApiKey.create).not.toHaveBeenCalled();
  });

  it('refuses a second key while a live one exists', async () => {
    mcpApiKey.findMany.mockResolvedValue([keyRow()]);

    await expect(mintConnectionKey(SCOPE, { personName: 'Ada' })).resolves.toEqual({
      ok: false,
      reason: 'already_exists',
    });
    expect(mcpApiKey.create).not.toHaveBeenCalled();
  });

  it('mints beside a revoked key rather than counting it, and leaves it in place', async () => {
    // The dead row is the record of an administrator's revocation. Deleting it
    // to make room would erase that decision while looking like housekeeping.
    mcpApiKey.findMany.mockResolvedValue([]);

    const result = await mintConnectionKey(SCOPE, { personName: 'Ada' });

    expect(result.ok).toBe(true);
    expect(mcpApiKey.delete).not.toHaveBeenCalled();
  });

  it('forces every field on the row', async () => {
    await mintConnectionKey(SCOPE, { personName: 'Ada' });

    const data = mcpApiKey.create.mock.calls[0][0].data;

    expect(data.scopes).toEqual(CONNECTION_KEY_SCOPES);
    expect(data.scope).toEqual({ [RESPARKABLE_SCHEDULE_SPACE_KEY]: SPACE_ID });
    expect(data.createdBy).toBe(ACTOR);
    // An expiry the holder cannot see coming is a credential that stops working
    // mid-sentence; a scoped agent narrows nothing while reading as if it does.
    expect(data.expiresAt).toBeNull();
    expect(data.scopedAgentId).toBeNull();
  });

  it('carries the three protocol scopes and not resources:read', async () => {
    // Core's MCP resources include knowledge search. A key minted from a
    // settings page should not carry a grant nobody asked for.
    expect(CONNECTION_KEY_SCOPES).toEqual(['tools:list', 'tools:execute', 'prompts:read']);
  });

  it('derives the name from the person and the workspace', async () => {
    await mintConnectionKey(SCOPE, { personName: 'Ada' });

    expect(mcpApiKey.create.mock.calls[0][0].data.name).toBe(
      connectionKeyName('Ada', 'Study Group B')
    );
  });

  it('records the mint in the admin audit log, without the secret', async () => {
    const result = await mintConnectionKey(SCOPE, { personName: 'Ada', clientIp: '203.0.113.7' });

    const entry = vi.mocked(logAdminAction).mock.calls[0][0];
    expect(entry).toMatchObject({
      userId: ACTOR,
      action: 'mcp_api_key.create',
      entityType: 'mcp_api_key',
    });
    expect(JSON.stringify(entry)).not.toContain(
      result.ok ? result.value.plaintext : 'never-reached'
    );
  });

  it('returns the plaintext once, and logs none of it', async () => {
    const result = await mintConnectionKey(SCOPE, { personName: 'Ada' });

    expect(result.ok && result.value.plaintext).toMatch(/^smcp_/);

    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).not.toContain(result.ok ? result.value.plaintext : 'never-reached');
    expect(logged).not.toContain('keyHash');
  });
});

describe('rotateConnectionKey', () => {
  beforeEach(() => {
    mcpApiKey.findMany.mockResolvedValue([keyRow()]);
  });

  it('writes key material and nothing else', async () => {
    await rotateConnectionKey(SCOPE, 'key_1');

    // The assertion is the exhaustive key list, not the presence of the two.
    // `isActive` or `expiresAt` appearing here is precisely the regression this
    // guards, and a `toMatchObject` would not see it.
    expect(Object.keys(mcpApiKey.update.mock.calls[0][0].data).sort()).toEqual([
      'keyHash',
      'keyPrefix',
    ]);
  });

  it('refuses a key an admin deactivated, rather than reviving it', async () => {
    // Regenerating a dead key would let a person undo an administrator's
    // decision from their own settings page.
    mcpApiKey.findMany.mockResolvedValue([]);

    await expect(rotateConnectionKey(SCOPE, 'key_1')).resolves.toEqual({
      ok: false,
      reason: 'no_such_key',
    });
    expect(mcpApiKey.update).not.toHaveBeenCalled();
  });

  it('refuses a key belonging to another workspace', async () => {
    mcpApiKey.findMany.mockResolvedValue([
      keyRow({ id: 'key_elsewhere', scope: { [RESPARKABLE_SCHEDULE_SPACE_KEY]: 'spc_other' } }),
    ]);

    await expect(rotateConnectionKey(SCOPE, 'key_elsewhere')).resolves.toEqual({
      ok: false,
      reason: 'no_such_key',
    });
  });

  it('refuses an admin’s unscoped service key', async () => {
    mcpApiKey.findMany.mockResolvedValue([keyRow({ id: 'key_service', scope: null })]);

    await expect(rotateConnectionKey(SCOPE, 'key_service')).resolves.toEqual({
      ok: false,
      reason: 'no_such_key',
    });
  });

  it('only ever looks at keys this person created', async () => {
    // Another person's key is not filtered out after the fact; it is never
    // fetched, so there is no window in which it could be acted on.
    await rotateConnectionKey(SCOPE, 'key_1');

    expect(mcpApiKey.findMany.mock.calls[0][0].where.createdBy).toBe(ACTOR);
  });

  it('returns a fresh plaintext', async () => {
    const result = await rotateConnectionKey(SCOPE, 'key_1');

    expect(result.ok && result.value.plaintext).toMatch(/^smcp_/);
  });
});

describe('revokeConnectionKey', () => {
  it('deletes the row', async () => {
    // The holder's own decision, about their own credential, on a surface where
    // a deactivated row would mean nothing to them.
    mcpApiKey.findMany.mockResolvedValue([keyRow()]);

    await expect(revokeConnectionKey(SCOPE, 'key_1')).resolves.toEqual({
      ok: true,
      value: { id: 'key_1' },
    });
    expect(mcpApiKey.delete).toHaveBeenCalledWith({ where: { id: 'key_1' } });
  });

  it('misses a key that is not this person’s, live and in this workspace', async () => {
    mcpApiKey.findMany.mockResolvedValue([]);

    await expect(revokeConnectionKey(SCOPE, 'key_1')).resolves.toEqual({
      ok: false,
      reason: 'no_such_key',
    });
    expect(mcpApiKey.delete).not.toHaveBeenCalled();
  });
});

describe('a scope with no actor', () => {
  it('is refused rather than matching every orphaned key in the install', async () => {
    // `SpaceScope.actorUserId` is nullable for an anonymous public-link reader.
    // Such a reader cannot reach these routes, and `createdBy: null` would
    // match the keys of every erased person.
    const anonymous = spaceScopeFor({ spaceId: SPACE_ID, actorUserId: null, role: 'viewer' });

    await expect(readConnectionKeys(anonymous)).rejects.toThrow(/named actor/);
  });
});
