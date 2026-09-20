/**
 * Unit Tests: the Prisma exemption granted to `mcp/keys.ts` stays one table wide.
 *
 * `lib/framework/eslint.config.mjs` lets only `repo/**`, `access/**`,
 * `db-drift.ts` and this one service reach the database, because every brain
 * query is a space query or a shared query and a stray `prisma` import is how
 * an unscoped third kind gets written. The argument for exempting this file is
 * narrow and entirely about one table: `McpApiKey` is a core-owned credential
 * list with no `spaceId` column, so no `SpaceScope` can filter it.
 *
 * That argument covers `mcpApiKey` and nothing else. The failure it cannot
 * cover is the ordinary one: somebody later needs a user's name, or a space's,
 * or a task count, and this file already has `prisma` imported, so reaching for
 * it costs nothing and breaks no lint rule. One line, and D5 has a hole in it
 * that no boundary in the repo would report.
 *
 * So the exemption is asserted rather than trusted, by reading the source. A
 * source read rather than a behavioural one because the point is what the file
 * *can* reach, not what today's call paths happen to touch.
 *
 * Test Coverage:
 * - Every `prisma.<delegate>` in the file names `mcpApiKey`
 * - The sweep found delegates at all, so it cannot pass on a bad regex
 * - No transaction handle is opened, which would take the check off-piste
 *
 * @see lib/framework/resparkable/mcp/keys.ts
 * @see lib/framework/eslint.config.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

const SOURCE = readFileSync(join(process.cwd(), 'lib/framework/resparkable/mcp/keys.ts'), 'utf8');

/** Every `prisma.<name>` in the file, in source order. */
function prismaDelegates(source: string): string[] {
  return [...source.matchAll(/\bprisma\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
}

describe('the mcp/keys.ts Prisma exemption', () => {
  it('reaches mcpApiKey and nothing else', () => {
    const offenders = [...new Set(prismaDelegates(SOURCE))].filter(
      (delegate) => delegate !== 'mcpApiKey'
    );

    expect(
      offenders,
      'the exemption in lib/framework/eslint.config.mjs covers the MCP key table only — ' +
        'put any other read behind a repo/** function that takes a SpaceScope'
    ).toEqual([]);
  });

  it('found delegates at all, so the sweep is doing something', () => {
    // Without this, a renamed client or a changed call style would empty the
    // match list and every assertion here would pass while checking nothing.
    expect(prismaDelegates(SOURCE).length).toBeGreaterThan(0);
  });

  it('opens no transaction, where the delegate would no longer be named `prisma`', () => {
    // `prisma.$transaction(async (tx) => tx.user.findMany(...))` reaches any
    // table in the schema and matches none of the patterns above. If this file
    // ever genuinely needs a transaction, the sweep has to learn about `tx.`
    // first, and this failure is the prompt to do that rather than an
    // inconvenience to delete.
    expect(SOURCE).not.toContain('$transaction');
  });
});
