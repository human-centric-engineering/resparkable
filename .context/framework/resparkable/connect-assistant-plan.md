# Connect an AI assistant: self-service MCP keys

**Status: BUILT as phase 60, 2026-09-20.** Extends [`mcp.md`](./mcp.md), which
is the operator-facing half of the same feature and now carries the
person-facing path too.

## What changed between this plan and what was built

Three things, and each is a place the plan was written against a world that has
since moved.

**1. It did not wait for Sunrise 0.13, because 0.13 does not exist.** The
gate below reads "build after merging Sunrise 0.13", and it is there for D3
alone: stamping `McpApiKey.orgId` at mint. That column is not in any released
tag. It arrived on upstream `main` in
[#815](https://github.com/human-centric-engineering/sunrise/pull/815), untagged,
beside in-flight §106/§107 tenancy work including an RLS spike. Merging an
unreleased mid-refactor branch into the fork to gain one nullable column that is
inert at `TENANCY_MODE=single`, which is how Resparkable runs, was the worse
trade. **D3 is deferred, not dropped**: `mcp/keys.ts` says in its own header
where the line goes when the column lands, which is `orgId: orgForMint()` on the
create and nothing at all on rotate.

**2. Claude Desktop moved to the "cannot connect" list.** D7 says to check the
client list at build time because it moves, and it had. Claude Desktop's remote
path is Custom Connectors: a URL, and then the server's own sign-in flow. There
is no header field, and its config file's server entries are local
`command`/`args` ones. So it sits with the web chat assistants rather than with
Claude Code. Verified against the clients' own documentation on 2026-09-20, and
`client-snippets.ts` records the date so the next reader knows how stale it is.
The four that do work are Claude Code, Cursor, VS Code and Windsurf.

**3. The service needed an ESLint exemption the plan did not anticipate.**
`lib/framework/eslint.config.mjs` lets only `repo/**` and `access/**` reach
Prisma. `McpApiKey` is a core-owned table with no `spaceId` column, so no
`SpaceScope` can filter it, and putting it in `repo/**` would have meant the
first repo function keyed on the **actor** — which §23.2 forbids and
`isolation.test.ts` asserts against. `mcp/keys.ts` is exempted alongside
`db-drift.ts`, and `keys-boundary.test.ts` holds that exemption to the one
table by reading the source.

Everything else landed as designed, including the D1 guard, D2's one-predicate
rule, D4, D5 and D6.

**Modelled on HCE Hub's Connect tab.** The Hub (`human-centric-engineering/hce-hub`)
already ships member self-service MCP keys, and has paid for several lessons
this plan inherits rather than relearns. Its docs are `.context/app/mcp-project-scope.md`
and `.context/app/mcp-claude-code.md`; its code is `lib/projects/mcp-keys.ts`,
`lib/app/mcp/key-scope.ts`, `app/api/v1/projects/[id]/mcp-keys/` and
`components/hub/projects/connect/connect-panel.tsx`. Where this plan departs from
the Hub it says so and says why (see [Departures](#departures-from-the-hub)).

## The gap

Everything an AI assistant needs to reach someone's brain over MCP already
exists: eight tools, three prompts, per-user isolation from the key's creator
(`mcp.md`). What does not exist is a way for a **person** to get a key. Minting
lives at `/admin/orchestration/mcp/keys` behind `withAdminAuth`, and the key's
creator is the brain it reaches, so on any install with more than one person an
admin has to sign in _as you_ to connect your assistant. In practice that means
it does not happen.

This phase adds a Connect card for the open workspace: generate a key, copy the
setup snippet for your client, regenerate or revoke it later.

**It is not a Claude feature.** MCP is an open protocol and the server does not
care who is on the other end. The card is called "Connect an AI assistant", the
snippets cover several clients, and nothing in the copy, the routes or the
schema names a vendor.

## The model: one key per person per workspace

The Hub binds a key to a **project**; Resparkable binds it to a **workspace**.
Everything else follows from that one substitution.

```
Resparkable, a workspace you belong to
  └─ Connect card → mints McpApiKey {
        createdBy: you, orgId: <request's org>,
        scope: { resparkableSpaceId: <space id> },
        scopes: [tools:list, tools:execute, prompts:read] }
       └─ paste the snippet into your assistant's MCP config
Your assistant
  └─ every tool call runs as you, in that workspace,
     with membership re-checked on the call
```

Two layers, both keyed to the key's owner, exactly as in the Hub:

- **Identity.** `protocol-handler.ts` sets `CapabilityContext.userId` from
  `createdBy`. A key acts as its creator, so it is a personal secret; sharing it
  hands over your identity.
- **Membership, checked twice.** At mint, the person must belong to the
  workspace. On every call, `requireResparkableSpace()` route 1 reads
  `scope.resparkableSpaceId` and resolves it through `resolveActiveSpaceScope()`,
  which returns nothing for a space the person has left. Leaving a group removes
  the key's reach at once, with no cleanup job. This is already built: phase 53's
  "MCP keys naming one workspace" needs no new code on the call path.

**The person chooses nothing.** This is the Hub's central safety argument and it
applies here unchanged: a self-service surface is safe because everything on it
is forced or derived.

| Property | Value                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Count    | **One live key per person per workspace.** Generating when one exists is refused (409); you regenerate or revoke                |
| Name     | Derived, `"<person> · <workspace>"`. Not asked for, not shown on the card; it is the label the admin keys page renders          |
| Scope    | Forced to `{ resparkableSpaceId: <canonical space id> }`, resolved through membership. Never a slug, never from the body        |
| Scopes   | Forced to `tools:list`, `tools:execute`, `prompts:read` (see [Departures](#departures-from-the-hub))                            |
| Expiry   | None written. A non-null `expiresAt` on one of these keys therefore came from an admin                                          |
| Org      | `orgForMint()`, the org the request entered. Never a body field                                                                 |
| Agent    | `scopedAgentId` left null, as the Hub does. `userId` already attributes cost (Sunrise #708), and a scoped agent narrows nothing |

## Decisions

### D1. A scope Resparkable cannot read is refused, not ignored

This is the Hub's t-134, and Resparkable has the same hole today.
`McpApiKey.scope` is an open map, and core will store whatever an admin types.
Two ways it goes wrong today:

- **Wrong key name** (`{ spaceId: '…' }`). `requireResparkableSpace()` looks for
  `resparkableSpaceId`, finds nothing, and falls through to the person's
  **default** workspace. The key works, and quietly writes captures into the
  wrong brain while looking correctly scoped. This is the dangerous one.
- **Right name, wrong value** (a slug, or a space they are not in). Membership
  resolution returns nothing and every call fails, but as
  `MissingResparkableUserError`, which reads as "who are you?" rather than "your
  key is wrong".

So Resparkable states its own shape, following `lib/app/mcp/key-scope.ts`:

| Carrier                              | Reading                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `NULL` or `{}`                       | **unscoped**: acts in the person's default workspace                           |
| `{ resparkableSpaceId: <space id> }` | **scoped**: the only shape a person's key may carry                            |
| anything else                        | **unusable**: the dispatch is refused, and the message says how to fix the key |

`classifyResparkableKeyScope()` and a `refuseUnusableResparkableScope`
`CapabilityGuard` live in `lib/framework/resparkable/mcp/key-scope.ts`. The guard
is attached to **every** Resparkable capability registration in
`lib/framework/resparkable/capabilities/index.ts`
(`registerAppCapability(capability, { guard })`). The seam already exists in
this tree (`CapabilityRegisterOptions.guard`, `lib/orchestration/capabilities/types.ts`),
so D1 does not wait on the merge and could ship first on its own.

**The one place this is harder than in the Hub: scheduled runs.** The guard
classifies only an authoritative carrier (`context.scopeIsAuthoritative`), and a
scheduled workflow's scope is authoritative too. It carries the schedule's own
keys (`RESPARKABLE_SCHEDULE_OWNER_KEY`, `resparkableSpaceId`, and the legacy
`resparkableUserId`), which is not the MCP key shape. So the guard must pass
unattended runs through (`isUnattendedRun(context)`) and classify only the rest.
Getting this wrong stops every 04:30 run, so it needs a test that dispatches a
real scheduled-run context through the guard, not only an MCP one.

A roster test, like the Hub's `project-scope-roster.test.ts`, fails if any
registered Resparkable capability is missing the guard.

### D2. A dead key is no key: one rule, every reader

The Hub's t-77 and t-161. Admins revoke two ways: `PATCH isActive: false`, or a
past `expiresAt`. MCP auth rejects both. If the member surface only checks one,
the card shows a key that cannot connect, and Regenerate writes fresh secret
material onto a dead row and reports success.

So one expression of the rule, `liveKeyWhere()`, is used by all four readers
(as built: the plan proposed an `isLiveKey()` predicate beside it, and nothing
called the predicate, so two encodings of one rule became one):
the one-per-workspace cap, the list, regenerate and revoke. And:

- **Regenerate does not reactivate** a deactivated key and **does not clear**
  an expiry. Either would let a person undo an admin's decision from their own
  card.
- **A dead row is left in place**, as the record of the admin's revocation. The
  cap ignores it, so the card offers Generate and a fresh key is minted
  alongside.
- **The card lists every live key, not the first.** One per workspace is the
  rule, not a database constraint: the cap is read-then-write, and an admin
  reactivating an old key leaves two. Rendering `keys[0]` hides a working
  credential from its owner.

### D3. Org binding (Sunrise 0.13, §106)

After the merge, `McpApiKey.orgId` exists (`onDelete: Cascade`), and
`authenticateMcpRequest()` refuses a key whose org is suspended, or which has no
org when `TENANCY_MODE=multi`. Both mint and rotate follow the admin route:

- Create writes `orgId: orgForMint()`. That reads the tenant context `withAuth`
  entered for the request. It is never a body field, so nobody can mint into an
  org they are not acting in.
- Rotate never touches `orgId`, matching core's rotate route.
- Membership of the workspace is checked inside the same org context, so a
  workspace in another org is `not_found`.

Resparkable runs single-tenant, where a null org reads as the install org, so
omitting `orgId` would appear to work in dev and then refuse every key the day a
deployment flips to `multi`. Test it at both settings.

### D4. Browser session only

`POST` and rotate refuse an API-key session (`isApiKeySession`), same as
`/api/v1/user/api-keys`: a key minting a key is privilege laundering. The Hub
does not have this check; it should, and that is worth raising with it.

### D5. Erasure deletes a person's workspace keys

`McpApiKey.createdBy` is `onDelete: SetNull` in core, and core's schema is not
ours to change. After erasure the key survives with `createdBy: null`. It
reaches nothing (`requireResparkableSpace` throws without a user), but it still
authenticates, lists tools and writes audit rows.

So Resparkable's `scrubInTransaction` erasure hook
(`lib/framework/resparkable/privacy/erasure.ts`) deletes `McpApiKey` rows where
`createdBy = userId` and the scope classifies as **scoped** (D1). Admin-minted
unscoped service keys are left to core's `SetNull`, which is the right fate for
a key an admin issued. The existing `McpApiKey` row in `export-sources.ts`
already covers subject access.

### D6. Server off means the card says so

`McpServerConfig.isEnabled` defaults to false. When it is off, `GET` reports
`serverEnabled: false`, the card explains that the server administrator has not
switched this on, and `POST` returns 409. A key that cannot connect invites
twenty minutes of debugging a client config.

### D7. Some assistants cannot use a key at all, and the card says which

Core's MCP server is **bearer-only**. Sunrise 0.13's `mcp.md` now says so
directly: bearer auth gives no per-end-user identity, and that is what OAuth
solves. Clients that let you set a header work: Claude Code, Claude Desktop,
Cursor, VS Code, Windsurf, and any client with a "URL plus headers" config.
Clients whose connector flow only speaks OAuth, which today includes the web
apps of the large chat assistants, cannot connect. **Check the current list at
build time**; it moves.

The card names the supported clients and says plainly that some assistants need
a sign-in flow this server does not offer yet. OAuth 2.1 is a core change: file
a Sunrise ask (a row in `sunrise-asks.md` plus an issue), with this card as the
motivating case.

## API

Per workspace, the way the Hub's routes are per project. `withAuth`, standard
envelope, added to `RESPARKABLE_API`. The `[spaceId]` segment is resolved
through membership; a workspace the caller is not in is 404.

```
GET    /api/v1/resparkable/spaces/:spaceId/mcp-keys                # your live keys for it, plus serverEnabled
POST   /api/v1/resparkable/spaces/:spaceId/mcp-keys                # generate (no body; plaintext once)
POST   /api/v1/resparkable/spaces/:spaceId/mcp-keys/:keyId/rotate  # regenerate (fresh secret, same row)
DELETE /api/v1/resparkable/spaces/:spaceId/mcp-keys/:keyId         # revoke (delete the row)
```

Every op resolves a key the caller **created** that is **live** and **scoped to
this workspace**. Anything else (another person's key, an admin key, a key for a
different workspace, a dead key) is `not_found`: one answer, so the route
confirms nothing about keys that are not yours. No hash ever leaves the service.

The service lives in `lib/framework/resparkable/mcp/keys.ts` (the Hub's
`lib/projects/mcp-keys.ts`), so the routes stay thin and the rules are testable
without HTTP. Generate, regenerate and revoke are recorded with
`logAdminAction`, as the Hub does, so they appear in the admin audit log beside
admin-minted keys. No per-flow rate-limit sub-cap: the section cap from
`proxy.ts` plus one-per-workspace bounds it.

## The card

`components/resparkable/settings/connect-assistant-card.tsx`, rendered on
`/resparkable/settings` below `<AboutSparkey>`, for the workspace the page is
already targeting (`readSpaceTarget`). It reads `GET` once.

**States:** server off / no key (a Generate button) / a key (Regenerate,
Revoke) / just generated.

**Just generated:** the key in a copy field with copy feedback, and "You won't
see this key again. Copy it now." Below it, a snippet per client with the key
and URL filled in. The server entry is always named `resparkable`, from one
constant (`RESPARKABLE_MCP_SERVER_NAME`, the Hub's `HUB_MCP_SERVER_NAME`), never
from the workspace. The Hub learned this the hard way (t-171): a per-project
name made the snippet disagree with the docs and with every existing config.

- **Claude Code**: `.mcp.json` at the repo root (gitignored upstream), or
  `claude mcp add --transport http resparkable <url> --header "Authorization: Bearer <key>"`
  for a user-wide entry
- **Cursor**: the same `mcpServers` JSON, in `.cursor/mcp.json`
- **VS Code**: `.vscode/mcp.json`, whose top-level key is `servers`, not
  `mcpServers`
- **Claude Desktop, Windsurf**: that client's config file, path named
- **Other**: the URL and the header, for any client that takes both

Snippet templates live in one module (`lib/framework/resparkable/mcp/client-snippets.ts`)
so a changed client format is a one-file fix, with a test per client.

**One snippet caveat to say on the card**, from the Hub: two Resparkable
deployments in one config need a hand-rename, because the entries differ only
in `url` and pasting the second silently replaces the first.

**What you can do once connected**, one short list: ask what's on today, search
your notes, capture a thought. It says the assistant **can add to your inbox but
cannot change or file anything**, which the exposure manifest guarantees and is
the thing a person most wants to know before handing over a key.

Copy follows `ui-copy-plain-english` and `resparkable-being-not-having`: no
"never lose", no scope names, no vendor names outside the snippet tabs. Revoke
confirms inside the card, not in a browser dialog.

## Departures from the Hub

| Where              | The Hub                             | Here                                    | Why                                                                                                                                                                                                                                                        |
| ------------------ | ----------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol scopes    | `tools:list`, `tools:execute`       | adds `prompts:read`                     | Resparkable's three MCP prompts, above all `resparkable-capture`, are part of the feature. The cost: core's seeded prompts are enabled too and will appear in the person's slash menu. They are templates, not data, so this is noise rather than exposure |
| Scope binding      | `scopedBy: 'projectId'` on 25 verbs | none                                    | No Resparkable capability takes a workspace argument, deliberately (`base.ts`: a workspace named by a model is named by whatever it last read). The key's space reaches capabilities through `requireResparkableSpace()`, not argument binding             |
| Scheduled runs     | no Hub verb dispatched from one     | the guard must pass them through        | D1. Resparkable's background work is built from `tool_call` steps carrying their own authoritative scope                                                                                                                                                   |
| Minting over a key | not refused                         | refused                                 | D4                                                                                                                                                                                                                                                         |
| Erasure            | not addressed                       | scoped keys deleted in the erasure hook | D5                                                                                                                                                                                                                                                         |
| Client snippets    | Claude Code `.mcp.json` only        | several clients                         | Any MCP client, not one vendor's                                                                                                                                                                                                                           |

**Not adopted now, worth adopting later:**

- **The stale tool-list notice** (`hubNotice`, `lib/projects/mcp/tool-revision.ts`).
  After a deploy that changes a tool, a client's cached list is stale and nothing
  says so. The Hub hashes the published list and tells the caller, inside tool
  results, to reconnect. Resparkable's list changes rarely; revisit when it
  doesn't.
- **Retiring a tool by name** (`098-retire-verbs.ts`). Nothing prunes an
  `McpExposedTool` row whose capability was deleted, so the tool stays
  advertised and fails on call. Adopt the first time a Resparkable capability is
  retired.

## Tests

| #   | Asserts                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A key generated by A, used over MCP, captures into that workspace, and `resparkable_search` returns none of B's rows            |
| 2   | A key for a group workspace stops reaching it the moment A leaves the group (next call fails, no job)                           |
| 3   | A `viewer` in a group workspace: the key's `resparkable_capture` is refused exactly as the HTTP write path refuses it           |
| 4   | D1: an unusable carrier (wrong key name, slug, extra key) is refused with the fix in the message; unscoped and scoped keys pass |
| 5   | D1: a real scheduled-run context passes the guard unchanged                                                                     |
| 6   | D1 roster: every registered Resparkable capability carries the guard                                                            |
| 7   | D2: a deactivated or expired key is absent from the list, does not count toward the cap, and 404s on regenerate and revoke      |
| 8   | D2: regenerate neither reactivates nor clears a future expiry; two live keys both render                                        |
| 9   | Generate when a live key exists: 409. Generate for a workspace A is not in: 404, no row                                         |
| 10  | Rows carry exactly the forced scopes, the canonical space id, null `scopedAgentId`, the request's `orgId`                       |
| 11  | Another person's key, an admin's unscoped key, or a key for another workspace: `not_found` on every op                          |
| 12  | `POST` and rotate from an API-key session: 403                                                                                  |
| 13  | D3 at `multi`: the key carries the org and authenticates; a key minted in another org cannot reach this workspace               |
| 14  | D5: erasure deletes A's scoped keys and leaves A's admin-minted unscoped keys to `SetNull`                                      |
| 15  | Server disabled: `GET` says so, `POST` 409                                                                                      |
| 16  | No response or log line contains a plaintext key or a hash                                                                      |
| 17  | Each snippet renders valid syntax for its client, with the server named `resparkable`                                           |

Tests 1 to 3 are the isolation invariants `plan.md` §16 6d asks for over the MCP
entry point; they belong in the isolation suite, not only here.

## Order of work

1. **D1 on its own**, before the merge if convenient. It closes a hole that
   exists today for admin-minted keys, and needs nothing new from Sunrise.
2. Merge Sunrise 0.13.
3. The service, routes and card (D2 to D7).

## Docs to update when built

- `mcp.md`: "Setting it up" gains a "for a person" path pointing here. Fix step
  2, which tells the operator to set `scopedAgentId` through a form that has no
  such field. Describe the D1 scope shape for admins minting by hand.
- `plan.md` §15: the phase row. §24.2's table: mark the MCP-key row delivered.
- `install.md`: the operator still has to switch the server on (D6).
- `CHANGELOG.md`: the new routes are framework-tier, not Sunrise's public
  surface as `VERSIONING.md` defines it. Check before the PR rather than assume.

## Out of scope

- OAuth for clients that require it (D7, upstream ask).
- Letting a person choose which tools a key gets. The manifest decides, for the
  reasons in `mcp.md`.
- Keys that span workspaces. A person with three workspaces generates three
  keys, or an admin mints an unscoped one that acts in their default.

## Aside: MCP resources are unblocked

`mcp.md` says MCP resources are deferred because a fork cannot register a
resource handler (ask #32, sunrise#540). `lib/app/mcp-resources.ts` now exists
with `registerMcpResourceHandler`, so that seam has landed. The Hub goes one step
further: its `hub://process/*` resources are governed by `tools:list` rather than
the blanket `resources:read`, through a core seam that lets a resource type name
its governing scope (sunrise#678). If that seam is in the merged tree,
`resparkable://today` could be readable by these keys without granting them
`sunrise://` knowledge search. Separate work.

**Done, 2026-09-20.** Both resources are built:
[`mcp/resources.ts`](../../../lib/framework/resparkable/mcp/resources.ts), rows
in `006-mcp`, and `mcp.md`'s deferral section replaced by
[what they are and how they are scoped](./mcp.md#resources-two-and-how-they-are-scoped).
The governing-scope seam is **not** in the merged tree, so the second half of
this aside still stands: reading them needs `resources:read` on a hand-minted
key, and the card's three scopes are unchanged.
