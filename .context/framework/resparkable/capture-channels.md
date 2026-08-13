# Capture channels

Every way a thought reaches the inbox, what `ResparkableThought.source` it lands
with, and — for the one channel that has no session — the threat model that
makes it safe. Written for phase 9 (`plan.md` §8, `phase-9-plan.md`), which
closed the last two gaps: image capture and email-to-inbox.

## The nine sources, at a glance

| `source`   | Where it's produced                                                                                                                                                    | Dedup key                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `web`      | Typed into `QuickCapture`, or extracted from a dropped document (`AttachmentCard`'s "read into capture" path) — see below for why extraction doesn't get its own value | — (whatever the browser sends)                                    |
| `voice`    | `VoiceCaptureButton` → `POST /transcribe`, transcript appended to the box, then a normal `web`-shaped submit that carries `source: 'voice'`                            | —                                                                 |
| `image`    | `ImageCaptureButton` → `POST /transcribe/image`, extracted text appended the same way                                                                                  | —                                                                 |
| `shortcut` | An iOS Shortcut → `POST /capture` with a personal `AiApiKey`                                                                                                           | `externalId` (Shortcut run id)                                    |
| `email`    | Postmark inbound → `resparkable_capture_for_token` → `captureThought`                                                                                                  | `messageId` (Postmark's `MessageID`), at three layers — see below |
| `chat`     | _(reserved; not currently produced — see the note at the end)_                                                                                                         | —                                                                 |
| `agent`    | `resparkable_capture`, bound to `resparkable-companion` — a thought captured mid-conversation                                                                          | —                                                                 |
| `api`      | _(reserved for a future direct API-key integration beyond the Shortcut path)_                                                                                          | —                                                                 |
| `pwa`      | The share-target landing page (`/resparkable/capture`), tagged only while the pre-filled draft is unedited — see below                                                 | —                                                                 |

`vault` (a tenth value) is Release 3's Obsidian import origin, unrelated to
capture proper — see `README.md`'s vault section.

## Web, voice, image and documents — one destination, an honest `source`

`QuickCapture` (`components/resparkable/layout/quick-capture.tsx`) is the
single textarea every one of these four paths feeds. Typing, dictating,
photographing and dropping a file in all end up as text in the same box, edited
before a person presses Capture — nothing auto-saves.

**`source` follows the most recent thing that produced the words on screen, not
how the box was opened.** `VoiceCaptureButton`/`ImageCaptureButton` append their
result with a tag (`'voice'`/`'image'`); any keystroke in the textarea clears
the tag back to unset, which is what the schema's own default (`'web'`) covers.
So a transcript edited by hand before capture is honestly `'web'` — the person
authored what was actually sent, dictation was just how the first draft
arrived. The share-target page (below) uses the same mechanism from the other
direction — `initialSource="pwa"` seeds the tag before the box even mounts,
rather than appending into an existing draft — but the clearing rule is
identical.

**Document extraction stays `'web'` — there is no `'document'` source value.**
`THOUGHT_SOURCES` doesn't have one, and `AttachmentCard`'s "read into capture"
path (as opposed to "add to Documents", which files the original) hands text
back the same way a transcript does. This was a deliberate choice, not a gap:
adding a tenth value for one UI affordance that behaves identically to typing
once the text is in the box would be a distinction nothing reads.

**Neither voice nor image capture persists the original.** `POST /transcribe`
and `POST /transcribe/image` both ship bytes to a provider and drop them — the
only write on the happy path is `logCost`. If someone wants the file kept,
"Add to Documents" already exists for exactly that; capture is for the words,
not the artefact.

## Shortcut capture — two-second, on a wider-than-ideal key

`install.md` §4.3 has the full recipe: mint a personal `AiApiKey`, POST to
`/api/v1/resparkable/capture` with `{ content, source: 'shortcut', externalId }`.

**The key is broader than the job**, and this is tracked, not overlooked.
`AiApiKey.scopes` is a closed enum in two Sunrise-owned files
(`lib/auth/api-keys.ts`, `lib/validations/orchestration.ts`), so the narrow
`resparkable` scope the design wanted cannot be minted from this tier without
editing core — which the tier's whole design avoids. `sunrise-asks.md` #34
([sunrise#542](https://github.com/human-centric-engineering/sunrise/issues/542))
names the gap; until it lands, a Shortcut key reaches every authenticated
route as its owner, not just capture. Give it an `expiresAt`, and revoke it if
the phone goes missing.

## Email-to-inbox — the one channel with no session

`brain+<inboxToken>@<RESPARKABLE_INBOX_DOMAIN>` routes through Postmark's
generic inbound-parse adapter (`lib/orchestration/inbound/adapters/postmark.ts`,
`.context/orchestration/inbound-triggers.md`) to
`resparkable-capture-intake`, a one-step workflow whose `tool_call` invokes
`resparkable_capture_for_token`. Nothing here is Resparkable-specific except the
capability, the workflow and the one `AiWorkflowTrigger` row
(`008-capture-intake-trigger.ts`) — the adapter, the route and the Basic-auth
verification are platform code, unmodified.

### The threat model

Every other capability in the tier is unreachable without a resolved owner —
`ResparkableCapability.execute()` guarantees that before `run()` is ever called.
`resparkable_capture_for_token` cannot use it: a Postmark webhook authenticates
_Postmark_ (Basic auth on the route), not the sender, so there is no
`context.userId` a session or an MCP key put there. It extends the platform's
`BaseCapability` directly and resolves ownership itself, from the payload —
`plan.md` §8's one deliberate exception to "userId always from context."

Two checks stand in for the session it doesn't have:

1. **`mailboxHash` resolves to a space.** The `+token` half of the address is
   `ResparkableSpace.inboxToken` — a 32-character bearer credential, generated
   from 16 random bytes (`generateInboxToken()`, `services/space.ts`), known to
   nobody but its owner and whatever mail client they configure to send to it.
   An unknown token is refused (`unknown_inbox_token`) before any other lookup
   runs.
2. **`from.email` matches that resolved owner's own verified account email**,
   case-insensitively. Anyone who learns the address can send to it — Postmark
   will happily deliver — so this is the check that turns "an email arrived"
   into "an email arrived from the account holder." An unverified account
   email, a mismatched sender, or a deleted account all fail the same way
   (`sender_mismatch`), deliberately: none of them get a more specific error
   that would help an attacker enumerate which case they hit.

Failing either captures nothing. There is no partial-trust path — the message
is either filed under the right brain or not filed at all.

### Why chat and MCP can't reach it, even though nothing stops a `tool_call` step from calling any capability

`tool_call` steps dispatch under a synthetic `agentId: workflow:${workflowId}`,
never a real agent's, and the capability registry defaults to allow when no
`AiAgentCapability` binding row exists for that synthetic id — so **the
binding table is not what gates a `tool_call` step.** What it _does_ gate is
the tool list a chat turn's model is shown: the streaming handler advertises
only the capabilities the addressed agent has an enabled row for.

So the real compensating controls are:

- **`resparkable_capture_for_token` is bound only to `resparkable-intake`**
  (`004-agent-capabilities.ts`), a seventh agent that exists solely to hold
  this one binding and is never issued a turn by any executor.
- **`resparkable-intake` is absent from `RESPARKABLE_CHAT_AGENT_SLUGS`**
  (`agents.ts`) — the chat route's own allowlist — so even if it _were_
  addressed, the chat surface would refuse it before the first turn.
- **No `McpExposedTool` row exists for it.** MCP's default is deny
  (`006-mcp.ts`'s own header: "a capability with no row here is not reachable
  over MCP at all"), so it needs no explicit exclusion there.

Binding it to `resparkable-companion` — the one chat-reachable agent — would
undo the first two controls in one line. That is the mistake this whole
section exists to prevent someone from making while reorganising
`004-agent-capabilities.ts` for an unrelated reason.

### Why `tool_call` receives the raw payload instead of named arguments

`resparkable-capture-intake`'s single step declares no `args` and no
`argsFrom`. That is not an oversight: `tool_call` is the one step type whose
`config.args` is never template-interpolated — every other step type resolves
its own `{{trigger.*}}` fields individually (`interpolatePrompt` has ten call
sites; `executors/tool-call.ts` is not one of them), so a
`'{{trigger.mailboxHash}}'`-style literal in a `tool_call`'s `args` would reach
the capability as that literal string, not the resolved value. Omitting `args`
lets the executor fall through to `ctx.inputData` — for an inbound-triggered
execution, `{ trigger: <the Postmark adapter's normalised payload> }`, written
verbatim by the inbound route — which is exactly what
`agentCaptureForTokenSchema` is shaped to accept. See that schema's own header
comment in `validations.ts` for the full reasoning, and
`workflows/definitions.ts`'s `gather_inputs` step (the morning briefing) for
the same pattern used one phase earlier, for a different reason (letting a
regenerate override through rather than letting a trigger payload through).

### Dedup, at three layers

A redelivered webhook, a flaky retry and a double-tapped Shortcut button all
have to answer "already got that" rather than filing a second inbox item:

1. **The inbound route itself** dedupes on `(workflowId, triggerExternalId)` —
   a unique-constraint violation on Postmark's `MessageID` returns
   `{ deduped: true }` before an `AiWorkflowExecution` row is even created.
   A redelivered webhook never reaches the workflow at all.
2. **The capability** forwards `messageId` as `captureThought`'s `externalId`,
   which dedupes at the `ResparkableThought` level — belt-and-suspenders for
   the case where two different execution rows somehow reference the same
   message.
3. **`captureThought`** itself is what every capture channel shares — the same
   idempotent front door `POST /capture` and `resparkable_capture` use.

### What still needs an operator

This section makes the workflow _reachable_; it does not make the mailbox
_live_. `RESPARKABLE_INBOX_DOMAIN` has to be set, `POSTMARK_INBOUND_USER` /
`POSTMARK_INBOUND_PASS` have to be set, and DNS has to route mail for that
domain to Postmark's inbound servers — see `install.md`.

## Chat and agent capture

`resparkable_capture` is bound to `resparkable-companion` (chat) and is the
only capability any workflow's `agent_call` step can reach that creates a
thought. `source: 'agent'` is pinned in the capability itself
(`capabilities/capture.ts`) — never accepted as an argument — for the same
reason `resparkable_capture_for_token` pins `source: 'email'`: the field is
what the triage prompt and the briefing read to decide how much of the wording
is the user's own, and a model that could set it would be able to launder its
own paraphrase as something the user said.

`source: 'chat'` is reserved in the enum but not currently produced by
anything — chat-originated captures go through `resparkable_capture` the same
as any other tool call and land as `'agent'`. If a future surface distinguishes
"the companion wrote this down because you said so" from "a workflow wrote
this down," `'chat'` is where that would go; nothing needs it split out today.
