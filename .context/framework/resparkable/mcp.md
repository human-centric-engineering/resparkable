# MCP — the brain, from inside your editor

Eight tools and three prompts, and **not one line of Resparkable MCP code**. The
whole feature is two kinds of database row seeded by
[`prisma/seeds/framework-resparkable/006-mcp.ts`](../../../prisma/seeds/framework-resparkable/006-mcp.ts)
from the manifest at
[`lib/framework/resparkable/mcp/exposure.ts`](../../../lib/framework/resparkable/mcp/exposure.ts).

That is not a happy accident. `protocol-handler.ts` sets
`CapabilityContext.userId` from the key's creator, and every Resparkable capability
already refuses to run without a `userId` — so per-user isolation over MCP is
the same owner-scope guard as everywhere else, reached by a different door.
Phase 6 paid for this without knowing it.

## The gotcha, first

**`McpApiKey.scopedAgentId` does not narrow what a key can call.**

It reads as though it does — "this key is scoped to `resparkable-companion`" — and
the scoping in `listMcpTools()` is real but **default-allow**: it drops only
capabilities that have an explicit `AiAgentCapability { isEnabled: false }` row
for that agent. Resparkable's bindings work by _absence_. A capability an agent may
not use simply has no row, and a missing row means allowed.

So every enabled `McpExposedTool` is callable by every key, whatever it is
scoped to. **The manifest is the access control**, which is why
`tests/unit/lib/framework/resparkable/mcp/exposure.test.ts` asserts what is on it
and — more importantly — what is not.

What `scopedAgentId` _does_ buy is real, just narrower than it looks: cost and
budget attribute to that agent, and knowledge-base retrieval resolves through
its grants.

## What is exposed

| Tool                           | Reads or writes | Why it is on the list                                                                                                         |
| ------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `resparkable_search`           | read            | The one that makes the rest worth having                                                                                      |
| `resparkable_list_tasks`       | read            | "What should I be doing" from the ranked list, not from what is open in the editor                                            |
| `resparkable_get_snapshot`     | read            | The whole picture in one call, instead of four searches reconstructing it                                                     |
| `resparkable_find_connections` | read            | Proposals only — it reads the graph, it does not write a link                                                                 |
| `resparkable_get_briefing`     | read            | Returns the stored briefing. No LLM call                                                                                      |
| `resparkable_get_stale_digest` | read            | What has gone quiet, asked from anywhere rather than only from `/resparkable/archive`                                         |
| `resparkable_ideate`           | read, costed    | A pure read that bills an LLM call — `isIdempotent: false`, uncached, and the one an operator might turn off to control spend |
| `resparkable_capture`          | **write**       | The premise. Adds an inbox item and nothing else                                                                              |

**Ten capabilities are deliberately absent.** Everything that creates structure
— `resparkable_upsert_project`, `_goal`, `_entity`, `_task`, `resparkable_link_entities`,
`resparkable_promote_thought`, `resparkable_write_review`, `resparkable_reprioritise` —
because those are the person's own decisions about the shape of their work, they
change what the scorer surfaces tomorrow, and an MCP client is the one caller
with no UI in which to notice that they happened. `resparkable_get_briefing_inputs`
and `resparkable_notify` are absent for a duller reason: they are plumbing for the
briefing workflow and mean nothing outside it.

An operator who wants one of them can enable it at
`/admin/orchestration/mcp/tools`. The default should not make that choice for
them.

### Rows are seeded enabled

Against core's default-deny (`McpExposedTool.isEnabled @default(false)`). That
default protects against exposure nobody thought about; these rows are a curated
list with a written reason each, and two operator gates still stand in front of
them — `McpServerConfig.isEnabled` is false until someone turns the server on,
and nothing reaches the server without a minted key. Seeding them off would put
eight admin clicks between installing Resparkable and the feature working, with no
decision made in between.

Re-seeding never re-enables a row an operator turned off. Same rule as
`004-agent-capabilities`: the update branch refreshes annotations and titles
(code artefacts — a stale `readOnlyHint` tells a client a write is safe to
retry) and leaves `isEnabled` alone.

## The three prompts

An MCP prompt is a **user-facing slash command**, not something the model
invokes on its own — the client expands the template into a message the person
sends. That makes a prompt the right shape for a _ritual_ and the wrong shape
for a lookup.

| Prompt                      | Arguments           | What it does                                                |
| --------------------------- | ------------------- | ----------------------------------------------------------- |
| `resparkable-weekly-review` | `focus` (optional)  | Walks the review: what moved, what did not, what to archive |
| `resparkable-what-now`      | `minutes`, `energy` | One thing to start, and why it and not the others           |
| `resparkable-capture`       | `thought`           | Straight to the inbox, no filing, no follow-up questions    |

Templates are **not** rewritten on re-seed — only the description is. A template
is editable at `/admin/orchestration/mcp/prompts`, and overwriting an operator's
tuning every deploy is the same mistake `005-workflows` avoids with workflow
definitions. Prompt `name` is never updated at all: core makes it immutable
post-create, because a rename breaks every client that bookmarked the command.

## Setting it up

There are two paths now, and for one person connecting their own assistant the
first one is the whole answer.

### For a person: the Connect card _(phase 60)_

`/resparkable/settings` → **Connect an AI assistant**. Generate, copy the key,
paste the snippet for your client. Nothing to choose: the key is minted for the
workspace the page is open on, with the three scopes below, acting as you.

One live key per person per workspace. Regenerate replaces the secret on the
same key; Revoke deletes it. An operator still has to have switched the server
on first, and the card says so plainly when they have not.

The routes behind it are
`/api/v1/resparkable/spaces/:spaceId/mcp-keys`; the rules are in
[`lib/framework/resparkable/mcp/keys.ts`](../../../lib/framework/resparkable/mcp/keys.ts).

**Which assistants can use one of these.** Core's MCP server is bearer-only, so
the dividing line is whether a client has somewhere to put a header. Claude
Code, Cursor, VS Code and Windsurf do, and the card gives each its own snippet.
**Claude Desktop does not**: its remote-server path is Custom Connectors, which
take a URL and then run the server's own sign-in flow, and there is no header
field. It sits with the web chat assistants, which the card names. OAuth 2.1
would fix all of them at once and is a core change (ask #49).

### For an operator: minting by hand

Still the right path for a service key, or for a key on behalf of someone who
cannot reach the card.

1. **Turn the server on** — `/admin/orchestration/mcp/settings`, set
   `isEnabled`. Off by default, and nothing else works until it is on.
2. **Mint a key** — `/admin/orchestration/mcp/keys`. Scopes: `tools:list`,
   `tools:execute`, `prompts:read`. The plaintext (`smcp_…`) is shown **once**.
   The key's **creator is the brain it reaches**, so mint it as the person whose
   brain it is.

   There is **no `scopedAgentId` field on this form**, and that is fine: it
   narrows nothing ([the gotcha](#the-gotcha-first)). It buys cost attribution
   and knowledge-grant resolution, and if you want those, set the column
   directly.

3. **Scope it to a workspace, or leave it empty.** See the next section, which
   is the part worth reading before typing into the scope field.

4. **Point a client at it:**

   ```bash
   claude mcp add --transport http resparkable https://your-host/api/v1/mcp \
     --header "Authorization: Bearer smcp_..."
   ```

   Then `what should I work on today?` and `capture that` work in the editor.

## The scope field: one shape, and everything else is refused

`McpApiKey.scope` is an open JSON map. Core names no keys in it and reads none,
so the admin form will store whatever you type. Resparkable reads exactly one
key, and since phase 60 it **refuses** a carrier it cannot read rather than
ignoring it.

| What you type                      | What happens                                            |
| ---------------------------------- | ------------------------------------------------------- |
| empty                              | The key acts in its creator's **default** workspace     |
| `{ "resparkableSpaceId": "<id>" }` | The key acts in that workspace, membership permitting   |
| anything else                      | Every tool call is refused, with the fix in the message |

The middle row wants the **canonical space id**, not a slug and not a group id.
Membership is re-checked on every call, so a key stops reaching a group
workspace the moment its owner leaves it, with no cleanup job.

**Why the third row is a refusal rather than a shrug.** A near miss such as
`{ "spaceId": "…" }` used to work: the reader found no `resparkableSpaceId`,
took the no-hint path, and the key acted in the creator's default workspace. It
looked correctly scoped in the admin list and quietly wrote captures into the
wrong brain. That is the failure the refusal exists to make impossible, and it
is why the legacy `resparkableUserId` spelling is refused here too even though
it appears to work on a one-workspace account.

Scheduled runs are unaffected: their scope carrier is a different shape and is
passed through untouched.
[`key-scope.ts`](../../../lib/framework/resparkable/mcp/key-scope.ts) is the
whole argument.

A running server caches both lists for five minutes. After a re-seed, restart or
wait before expecting `tools/list` to change.

## Resources: deferred, and why

The plan wanted `resparkable://today` and `resparkable://project/{slug}` as MCP
**resources** — a client can read a resource without spending a tool call, which
is the cheaper shape for a read.

They are not built. `resource-registry.ts` dispatches on `resourceType` through
a module-local `HANDLERS` map of core's four, which is neither exported nor
merged into, so a fork can insert the row and the registry logs "no handler for
type" and returns null. Filed as ask #32 in
[`resparkable-asks.md`](./resparkable-asks.md) →
[resparkable#540](https://github.com/human-centric-engineering/sunrise/issues/540).

Nothing is missing as a result — every read path is exposed as a tool and works.
The cost is one tool call where a resource read would have been free.

## See also

- [`agents.md`](./agents.md) — the binding model these rows sit alongside, and
  why absence is how a capability is withheld
- [`.context/orchestration/mcp.md`](../../orchestration/mcp.md) — core's MCP
  server: transport, auth, audit, session management
- [`install.md`](./install.md) — the operator steps, in the install checklist
