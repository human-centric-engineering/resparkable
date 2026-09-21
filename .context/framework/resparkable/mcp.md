# MCP — the brain, from inside your editor

Eight tools, three prompts and two resources, seeded by
[`prisma/seeds/framework-resparkable/006-mcp.ts`](../../../prisma/seeds/framework-resparkable/006-mcp.ts)
from the manifest at
[`lib/framework/resparkable/mcp/exposure.ts`](../../../lib/framework/resparkable/mcp/exposure.ts).

**The tools and prompts are rows and nothing else: not one line of Resparkable
code.** That is not a happy accident. `protocol-handler.ts` sets
`CapabilityContext.userId` from the key's creator, and every Resparkable capability
already refuses to run without a `userId` — so per-user isolation over MCP is
the same owner-scope guard as everywhere else, reached by a different door.
Phase 6 paid for this without knowing it.

**The two resources are the exception**, because core's resource path is not the
tool path: it runs no capability guards and hands a handler no scope carrier. So
[`mcp/resources.ts`](../../../lib/framework/resparkable/mcp/resources.ts) does
that work itself, and [its section below](#resources-two-and-how-they-are-scoped)
is about how it reaches the same three answers.

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

**Fifteen capabilities are deliberately absent**, in three groups.

**Everything that creates structure**: `resparkable_upsert_project`, `_goal`,
`_area`, `_entity`, `_task`, `_time_block`, plus `resparkable_link_entities`,
`resparkable_promote_thought`, `resparkable_write_review` and
`resparkable_reprioritise`. Those are the person's own decisions about the shape
of their work, they change what the scorer surfaces tomorrow, and an MCP client
is the one caller with no UI in which to notice that they happened.

**Workflow plumbing**: `resparkable_get_briefing_inputs`, `resparkable_notify`
and `resparkable_get_context_digest` are deterministic gather and delivery steps
that mean nothing outside the workflow calling them.

**The two capture doors that are not _the_ capture door**:
`resparkable_capture_context` is shaped for the `resparkable-context` agent's
"tell me more" conversation, and `resparkable_capture_for_token` is email intake,
trusted through a token rather than a key. `resparkable_capture` is the single
write on this surface, and the other two carry their own arguments in
[`capture-channels.md`](./capture-channels.md).

An operator who wants one of them can enable it at
`/admin/orchestration/mcp/tools`. The default should not make that choice for
them.

**The list above is enforced, not just written down.** `exposure.test.ts` holds
a `WITHHELD` map of every absent slug with its reason, and asserts that the
catalogue is exactly that map plus the manifest. A capability added later fails
the suite until somebody either exposes it or writes its line. That guard used
to be a hand-typed list of eight slugs plus two, which is how five capabilities
added after phase 7b (`_area`, `_time_block`, `capture_context`,
`get_context_digest`, `capture_for_token`) came to be absent by default rather
than by decision, and how this paragraph came to say "ten".

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

A card key reaches the eight tools and the three prompts. It does **not** reach
the two resources, which need `resources:read`:
[why](#they-need-a-scope-the-connect-card-does-not-mint).

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
   `tools:execute`, `prompts:read`, and `resources:read` if you want
   `resparkable://today` and `resparkable://project/{slug}` as well. The
   plaintext (`smcp_…`) is shown **once**.

   `resources:read` is the one scope worth a moment's thought: it also grants
   core's own resources, and an unscoped key runs `resparkable://knowledge/search`
   system-wide. Add it to your own key freely; think before adding it to one you
   mint for somebody else.
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

A running server caches these lists for five minutes. After a re-seed, restart or
wait before expecting `tools/list` or `resources/list` to change.

## Resources: two, and how they are scoped

A client can read a resource without spending a tool call: it attaches the
content to the conversation itself, where a tool call costs a round trip and a
decision by the model to make it. That is the cheaper shape for a read, and
these are the two reads a person opens a session already wanting.

| Resource                       | What comes back                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `resparkable://today`          | `buildToday()`, the same payload the Today page renders: ranked tasks, time blocks, inbox count, goals at risk                              |
| `resparkable://project/{slug}` | `buildProjectView()`, by slug: status, area, tasks, links. Slugs come from `resparkable://today`, which carries one on every task's project |

Everything else stays a tool, and the split is not "cheap reads become
resources". `resparkable_search` takes a query the model composes,
`resparkable_ideate` spends money, and `resparkable_find_connections` answers a
question nobody asked at the top of a session. Neither resource takes a read
away from anybody either: `resparkable_get_snapshot` covers the same ground as
`resparkable://today`, so a client with no `resources:read` loses the cheaper
door and keeps every answer.

### They need a scope the Connect card does not mint

Core gates `resources/read` on `resources:read`, and the card's keys carry
`tools:list`, `tools:execute` and `prompts:read` only. That omission is
deliberate and is
[`keys.ts`](../../../lib/framework/resparkable/mcp/keys.ts)'s own written
reason: core's resources include `resparkable://knowledge/search`, which an
unscoped key runs system-wide, and a key minted from a settings page should not
carry a grant nobody asked for.

So **these two resources are reachable by an admin-minted key that carries
`resources:read`, and not by a card key.** Closing that gap without widening the
card needs a core seam letting a resource type name its own governing scope
(sunrise#678, the shape the Hub already uses). Until then the honest summary is:
the resources are built, and the audience they were built for reaches them by
minting a key at `/admin/orchestration/mcp/keys`.

### The guard work, which the resource path does not do

`tools/call` arrives with the key's owner and its scope carrier folded into
`CapabilityContext`, runs `refuseUnusableResparkableScope`, and resolves a
workspace through `requireResparkableSpace()`. `resources/read` does none of
that: it hands a handler `ResourceCallContext`, which carries the owner and the
key id but **not** the carrier, and calls it.

[`mcp/resources.ts`](../../../lib/framework/resparkable/mcp/resources.ts)
therefore repeats the three answers in the same order, which is what stops the
second door having its own opinion about which brain it opens:

1. no owner, no read (a key whose creator was erased reaches nothing);
2. a carrier this tier cannot read is **refused**, by
   [the same classifier](#the-scope-field-one-shape-and-everything-else-is-refused)
   the tool path uses;
3. the workspace is re-resolved through membership on every call.

It reads `McpApiKey.scope` back from the row to do step 2, because core drops
the carrier on the way to a resource handler. A revoked key is refused rather
than read as unscoped: a missing row would otherwise classify as "no hint" and
answer about the person's default workspace.

Refusals come back as resource **content**, not as throws. `readMcpResource`
catches a throw and returns "Resource handler error" with no detail, which is
the opposite of what somebody holding a mis-scoped key needs.

### The seam this needed, and when it landed

`resource-registry.ts` used to dispatch through a module-local map of core's
four handlers that was neither exported nor merged into, so a fork could insert
a row and the registry would log "no handler for type" and return null. That was
ask #32 in [`sunrise-asks.md`](./sunrise-asks.md) →
[sunrise#540](https://github.com/human-centric-engineering/sunrise/issues/540),
and it is fixed: `registerMcpResourceHandler` exists, and
[`lib/app/mcp-resources.ts`](../../../lib/app/mcp-resources.ts) is where
Resparkable calls it.

Core pins its own resources to the `resparkable://` scheme and makes a fork name
its scheme explicitly, so that fork data cannot quietly list under the
platform's identity. These two pass `'resparkable'` on purpose: here the
platform and the tier are the same product, so naming it is a statement rather
than an inheritance.

### Two rough edges, because core's resources are install-wide and these are not

Core has only ever had resources that are the same for everybody on the install:
the agent list, the workflow list, knowledge search. Both of these are one
person's, and two pieces of the machinery around them were built on the first
assumption. Neither is fixable from this tier, and neither is worth working
around; they are written down so the next person meets them on paper first.
Both are ask #50 in [`sunrise-asks.md`](./sunrise-asks.md) →
[sunrise#823](https://github.com/human-centric-engineering/sunrise/issues/823).

**The project template also lists as a concrete resource.**
`listMcpResourceTemplates()` filters rows on the `{…}` placeholder;
`listMcpResources()` does not filter at all, so `resparkable://project/{slug}`
appears in `resources/list` as well as `resources/templates/list`. A client that
shows the first list offers a "Project" entry that can only be read literally,
and reading it literally gets the "use the slug from its URL" refusal rather
than a project. Core never met this because none of its own rows is a template.

**Subscribing to either works, and nothing ever fires.**
`resources/subscribe` accepts both URIs, and no Resparkable mutation calls
`broadcastMcpResourceUpdated`, so a subscriber holds its first snapshot forever.
The fix is not to wire it up: that broadcast takes a URI and notifies **every**
subscriber of it, with no notion of whose data changed, so firing
`resparkable://today` when one person captures a thought would signal it to
every other subscriber. Not firing is the lesser of the two wrongs. Until a
broadcast can name a user, read these resources again rather than subscribing.

## See also

- [`agents.md`](./agents.md) — the binding model these rows sit alongside, and
  why absence is how a capability is withheld
- [`.context/orchestration/mcp.md`](../../orchestration/mcp.md) — core's MCP
  server: transport, auth, audit, session management
- [`install.md`](./install.md) — the operator steps, in the install checklist
