/**
 * Test 13b: a non-member gets nothing from a group space, on every route, by
 * scope resolution and not by filtering (Release 9, phase 48).
 *
 * phase-46-plan.md calls this the single most important assertion in the
 * release. The failure it guards against is not a wrong filter; it is a route
 * that never asked. So it is a sweep over the route tree rather than a test per
 * route, for the reason `repo/isolation.test.ts` gives: nobody writes a test
 * for the route they forgot to scope.
 *
 * ## Two halves
 *
 * 1. **Structural.** No route file builds its own scope. Every route reaches a
 *    workspace through `requestSpaceScope()` (directly or through the handler
 *    factories), the membership service, or the access layer. The few that
 *    mint a personal scope themselves are listed below, each with its reason.
 * 2. **Behavioural.** Every route that serves a workspace is called, once per
 *    HTTP method it exports, carrying `?space=` for a group space the caller
 *    is not in. Every call must answer 404, and **no content table may be
 *    queried**. The database is a recording proxy, so a query the route made
 *    before or instead of asking is caught whatever table it touched.
 *
 * "404, having queried nothing" is what "by scope resolution and not by
 * filtering" means in a form a test can hold: a filtered query would at least
 * have been made.
 *
 * @see lib/framework/resparkable/api/space-request.ts
 * @see lib/framework/resparkable/services/membership.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RESPARKABLE_CHAT_AGENT_SLUGS } from '@/lib/framework/resparkable/agents';

/** Every Prisma call any route made, by delegate and method, with its arguments. */
const queries: Array<{ delegate: string; method: string; args: unknown }> = [];

/**
 * A database that answers every query with nothing and remembers being asked.
 *
 * Empty answers are the right default for this test: the membership read
 * returns no row, so the caller is a stranger to the space, which is exactly
 * the situation under test.
 */
vi.mock('@/lib/db/client', () => {
  const empty = (method: string): unknown => {
    if (method === 'findMany' || method === 'groupBy') return [];
    if (method === 'count') return 0;
    if (method.endsWith('Many')) return { count: 0 };
    // A write returns a row. The chat route makes sure the caller's personal
    // space exists before it resolves the target, and reads the result.
    if (method === 'create' || method === 'upsert' || method === 'update') return { id: 'row_1' };
    return null;
  };
  const delegate = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) => async (args: unknown) => {
          queries.push({ delegate: name, method, args });
          return empty(method);
        },
      }
    );
  const prisma: unknown = new Proxy(
    {},
    {
      get: (_target, key: string) => {
        if (key === 'then') return undefined;
        if (key === '$transaction') {
          return async (arg: unknown) => {
            queries.push({ delegate: '$transaction', method: 'call', args: null });
            return Array.isArray(arg) ? [] : undefined;
          };
        }
        if (key.startsWith('$')) {
          // Raw SQL is a tagged template: the values are the arguments after
          // the strings, and they are what says whose rows it touched.
          return async (...args: unknown[]) => {
            queries.push({ delegate: key, method: 'call', args: args.slice(1) });
            return [];
          };
        }
        return delegate(key);
      },
    }
  );
  return { prisma };
});

const routeLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock('@/lib/api/context', () => ({ getRouteLogger: async () => routeLog }));

vi.mock('@/lib/logging', () => ({
  logger: {
    withContext: () => routeLog,
    child: () => routeLog,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/auth/guards', () => {
  const wrap =
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, SESSION, context);
      } catch (error) {
        return handleAPIError(error);
      }
    };
  return { withAuth: wrap, withAdminAuth: wrap };
});

const SESSION = {
  user: { id: 'user_stranger', email: 'stranger@example.com', name: 'Stranger' },
  session: { userId: 'user_stranger' },
};

const ROUTES_ROOT = path.join(process.cwd(), 'app/api/v1/resparkable');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Every route file under the tier, relative to its root. */
function routeFiles(dir: string = ROUTES_ROOT): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === 'route.ts' ? [path.relative(ROUTES_ROOT, full)] : [];
  });
}

/** The source with comments removed, so a docblock mentioning a call is not a call. */
function code(relative: string): string {
  return readFileSync(path.join(ROUTES_ROOT, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Does this route serve a workspace chosen by `?space=`?
 *
 * Those are the routes 13b is about. The rest reach data some other way and
 * are accounted for in {@link OTHER_ROUTES}.
 */
const SPACE_ENTRY =
  /requestSpaceScope\(|create(Collection|Item|Restore|Snooze|Unsnooze|Summarize)Handlers?\(/;

/**
 * Routes that do not take their workspace from `?space=`, and why each is
 * still safe. Pinned, so a new route has to be placed deliberately.
 */
const OTHER_ROUTES: Record<string, string> = {
  'groups/route.ts': 'Lists the caller’s own memberships and creates a group. Not in a space.',
  'groups/[id]/route.ts': 'Resolves membership by group id through the membership service.',
  'groups/[id]/members/route.ts': 'As above.',
  'groups/[id]/members/[userId]/route.ts': 'As above.',
  'groups/[id]/invites/route.ts': 'As above.',
  'groups/[id]/invites/[inviteId]/route.ts': 'As above.',
  'groups/[id]/budget/route.ts': 'As above. The per-person half is admin-only in the service.',
  'groups/[id]/budget/top-up/route.ts': 'As above. The giver’s own space is their session’s.',
  'groups/[id]/budget/members/[userId]/route.ts': 'As above. Admin only in the service.',
  'groups/invites/accept/route.ts': 'Binds an invitation token to the session. Not in a space.',
  'invites/accept/route.ts': 'Binds a share invitation to the session. Not in a space.',
  'public/[token]/route.ts': 'A public link. The token is the whole authority.',
  'spaces/route.ts': 'Lists the workspaces the caller can open, for the switcher.',
  'spaces/[spaceId]/mcp-keys/route.ts':
    'Takes the workspace from the path and resolves it through the membership service. ' +
    'A credential is minted FOR a named workspace, so reading it from a query string the ' +
    'browser can drop would be one refresh away from minting against the wrong brain.',
  'spaces/[spaceId]/mcp-keys/[keyId]/route.ts': 'As above.',
  'spaces/[spaceId]/mcp-keys/[keyId]/rotate/route.ts': 'As above.',
  'space/route.ts': 'The caller’s own personal space settings.',
  'capture/route.ts':
    'Takes its target from the body and ignores ?space= (phase 47). A non-member target ' +
    'is refused in capture-target.routes.test.ts.',
  'transcribe/route.ts': 'Returns text to the capture box and writes nothing (phase 47).',
  'transcribe/image/route.ts': 'As above.',
  'documents/extract/route.ts': 'Extracts text from an upload and writes nothing.',
  'briefing/regenerate/route.ts': 'The caller’s own personal briefing.',
  'vault/export/route.ts':
    'Personal only, deliberately: what exporting a group workspace means is §24.5’s open question.',
  'vault/import/route.ts': 'As above.',
};

/**
 * Route files allowed to mint a scope themselves. Every other route asks.
 * The vault routes are personal by decision (phase 47, departure 5).
 */
const MINTS_ALLOWED = new Set(['vault/export/route.ts', 'vault/import/route.ts']);

const ALL = routeFiles().sort();
const SPACE_ROUTES = ALL.filter((file) => SPACE_ENTRY.test(code(file)));

describe('13b, structural: every route asks rather than decides', () => {
  it('finds the routes it is meant to sweep', () => {
    // Guard on the guard. A regex that went blind would empty this list and
    // every test below would pass while protecting nothing.
    expect(SPACE_ROUTES.length).toBeGreaterThan(60);
    expect(SPACE_ROUTES).toContain('tasks/route.ts');
    expect(SPACE_ROUTES).toContain('thoughts/route.ts');
  });

  it('places every route: either it takes ?space= or it is listed with a reason', () => {
    const unplaced = ALL.filter((file) => !SPACE_ROUTES.includes(file) && !(file in OTHER_ROUTES));

    expect(
      unplaced,
      `These routes neither resolve ?space= nor appear in OTHER_ROUTES with a reason. ` +
        `Decide which they are before they ship: ${unplaced.join(', ')}`
    ).toEqual([]);
  });

  it('lists no route in OTHER_ROUTES that has since started taking ?space=', () => {
    const both = SPACE_ROUTES.filter((file) => file in OTHER_ROUTES);
    expect(both).toEqual([]);
  });

  it('lists no route that no longer exists', () => {
    const stale = Object.keys(OTHER_ROUTES).filter((file) => !ALL.includes(file));
    expect(stale).toEqual([]);
  });

  it('never mints a scope in a route file, outside the personal-only vault routes', () => {
    const minting = ALL.filter(
      (file) => /\bspaceScope(For)?\(/.test(code(file)) && !MINTS_ALLOWED.has(file)
    );

    // `rg 'spaceScope\(|spaceScopeFor\('` is the list of trust boundaries in
    // the brain, and it is meant to stay short. A route minting its own is a
    // route that decided which brain it is in without asking.
    expect(minting).toEqual([]);
  });
});

/** Every param name a route in the tier uses, with a harmless value. */
const PARAMS = {
  id: 'row_1',
  entityType: 'task',
  entityId: 'row_1',
  userId: 'user_other',
  inviteId: 'inv_1',
  token: 'tok_1',
};

const GROUP_SPACE = 'spc_not_yours';

/**
 * Bodies for the routes that validate before they resolve. An empty body gets
 * those a 400 that leaks nothing but also proves nothing, so they get a valid
 * one and have to reach the scope check.
 */
const VALID_BODIES: Record<string, unknown> = {
  'chat/stream/route.ts': { message: 'hello', agentSlug: RESPARKABLE_CHAT_AGENT_SLUGS[0] },
};

function strangerRequest(file: string, method: string): Request {
  const segment = path.dirname(file).replace(/\[(\w+)\]/g, (_match, key: string) => {
    return PARAMS[key as keyof typeof PARAMS] ?? 'x';
  });
  const url = `http://localhost/api/v1/resparkable/${segment}?space=${GROUP_SPACE}`;
  const hasBody = method !== 'GET' && method !== 'DELETE';
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(hasBody ? { body: JSON.stringify(VALID_BODIES[file] ?? {}) } : {}),
  });
}

/**
 * Tables a request may read before it knows which workspace it is in: the
 * membership check, and the two deployment-wide settings singletons, which
 * hold no one's content (the chat route reads the billing one while making
 * sure the caller's own personal space exists).
 */
const RESOLUTION_TABLES = new Set([
  'resparkableGroupMember',
  'resparkableGroup',
  'resparkableSettings',
  'resparkableBillingSettings',
]);

/**
 * Was this query about something other than the membership check and the
 * caller's OWN personal space?
 *
 * The chat route makes sure the caller's personal space exists before it
 * resolves the target, which touches only their own row. Anything else is a
 * route reading before it asked.
 */
function reachedBeyondTheCaller(query: { delegate: string; args: unknown }): boolean {
  if (RESOLUTION_TABLES.has(query.delegate)) return false;
  const rendered = JSON.stringify(query.args ?? null);
  if (rendered.includes(GROUP_SPACE)) return true;
  return !rendered.includes(SESSION.user.id);
}

beforeEach(() => {
  queries.length = 0;
});

describe('13b, behavioural: a stranger to a group space gets a 404 and nothing else', () => {
  // A long timeout because of what gets imported, not what gets run: the chat
  // route pulls in the whole orchestration stack, which on a cold transform
  // takes most of the default 30 seconds by itself.
  it.each(SPACE_ROUTES)('%s', { timeout: 120_000 }, async (file) => {
    const mod: Record<string, unknown> = await import(
      /* @vite-ignore */ path.join(ROUTES_ROOT, file)
    );
    const exported = METHODS.filter((method) => typeof mod[method] === 'function');
    expect(exported.length, `${file} exports no handler`).toBeGreaterThan(0);

    for (const method of exported) {
      queries.length = 0;
      const handler = mod[method] as (request: Request, context: unknown) => Promise<Response>;

      const response = await handler(strangerRequest(file, method), {
        params: Promise.resolve(PARAMS),
      });

      const touched = queries
        .filter(reachedBeyondTheCaller)
        .map((query) => `${query.delegate}.${query.method}`);

      expect(response.status, `${method} ${file} answered ${response.status}`).toBe(404);
      expect(touched, `${method} ${file} queried content before refusing`).toEqual([]);
    }
  });
});
