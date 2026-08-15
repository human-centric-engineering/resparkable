# Phase 39 — context capture, sensitivity, and description sync

**Status: landed, 2026-08-13.** Release 1 (phases 0–9 + 7b) closed with phase 9
(`phase-9-plan.md`); this is the first phase of Release 8
(`plan.md` §15, "Context capture & description sync"), which requires only
Release 1 and nothing else.

Phase 39's deliverable, from `plan.md` §15 rows 39–43: `ResparkableThought.sensitivity`

- classifier, `resparkable_capture_context` + the `resparkable-context` agent,
  two new chat surfaces ("Tell me more" on Area/Goal/Project, and a freeform
  `/resparkable/context` page), the description-summariser (`resparkable-summariser`
  agent + `resparkable-context-digest` workflow), and the accept/dismiss review UI.
  Verifiable by: an anchored chat capture links to the right entity; a `sensitive`
  note is excluded from the summariser's input but not from GDPR export; accepting
  a proposed description round-trips through the same `PATCH` the boring form uses.

## 1. The problem this solves

Area, Goal and Project pages collected one thing beyond a name: a `description`
field — short, hand-typed prose. That's a real limit for someone trying to build
a fuller picture of their own life, relationships and work through the app: a
form field is a one-dimensional container, and the richer, tangential context
that comes out in conversation (a constraint, a person, a worry, a change) had
nowhere to go except a generic captured thought with no connection back to what
it was about.

This phase adds a chat-driven way to have that conversation, store what comes out
of it as first-class second-brain content — not a parallel, less-capable store —
and surface it back through an optional, human-reviewed rewrite of the
description itself. The boring fields stay exactly as they were for anyone who
prefers typing directly; nothing here is required.

## 2. Why this reuses Release 1's substrate rather than building a new one

Resparkable already has two candidate "knowledge base" primitives, and neither
was right on its own:

- **The admin orchestration knowledge base** (`AiKnowledgeBase`/`AiKnowledgeChunk`,
  `prisma/schema/orchestration-knowledge.prisma`) is explicitly documented
  (`.context/orchestration/knowledge.md`) as global and admin-managed, not
  per-user — and that doc tells forks needing user-scoped embeddings to add
  their own vector table rather than fork the admin one. Resparkable already did
  exactly that, in phase 1.
- **`AiUserMemory`** (`prisma/schema/orchestration-conversations.prisma`) is a
  per-user key-value store, unchunked and unsearchable — a plausible seed for
  "remember this about me", but not something a connections sweep or a semantic
  search can reach into.

`ResparkableThought` + `ResparkableEmbedding` + `ResparkableLink` — the capture
inbox, the shared pgvector table, and the polymorphic connection table Release 1
already built — is the richer, already-correct substrate. This phase adds one
column and two capabilities to it; it does not add a fourth storage system.

## 3. What was built

### 3a. Sensitivity classification (`ResparkableThought.sensitivity`)

A `public | private | sensitive` column, default `private`, classified by a
pure, synchronous, keyword-based heuristic (`services/sensitivity.ts`) — no LLM
call, because `captureThought()` is "the one write path that has to be faster
than thinking" and this runs inline on **every** capture channel, not just the
two new chat surfaces. `public` is never auto-assigned; a person opts into it by
hand later via `PATCH /thoughts/[id]`.

The gate this buys: `sensitive` thoughts are excluded from the morning
briefing's `resurfacedThought` and `topConnections` reads
(`services/briefing.ts`, threaded through `repo/thoughts.ts`'s
`excludeSensitive` filter and `repo/summaries.ts#findSummaries`'s new fifth
parameter) and from the description-summariser's gathered corpus
(`services/context-digest.ts`). It is **not** a restriction on which LLM
provider a chat turn is sent to — that was an explicit product decision, not an
oversight — and it is **never** applied to the GDPR export path
(`repo/subject-export.ts` reads every row regardless of classification).

Search and detail-page "related" panels are deliberately left unfiltered: those
are a person looking at their own data, not an unprompted background output.

### 3b. The capture door: `resparkable_capture_context`

A sibling to `resparkable_capture` (`capabilities/capture-context.ts`), pinning
`source: 'chat'` — a value `THOUGHT_SOURCES` has carried since phase 6 but that
nothing set until now. It reads its link target from
`context.entityContext` (the same field the admin chat route already threads
into `CapabilityContext`), never from a model argument — the anchor is set by
the page the user opened, the same trust boundary `owner-scope.ts` documents for
`userId`. When it resolves, it calls the existing `linkEntities` service
(`services/links.ts`) — the same function `resparkable_link_entities` and the
manual link route already call — so a resolved anchor and a hand-made link are
created identically, including the ownership check that makes a stale or
cross-user id degrade to "no link" rather than an error.

Bound to a new, deliberately narrow agent, `resparkable-context`
(`RESPARKABLE_AGENT_SLUGS.context`), which holds this one capability and
nothing else — the "bound to exactly one capability" pattern
`resparkable-intake` already established, so a reflective conversation cannot
wander into creating tasks or projects. Added to `RESPARKABLE_CHAT_AGENT_SLUGS`
alongside the companion.

### 3c. Two chat surfaces, one pipeline

- **Anchored** — `<ContextChatDrawer>` (`components/resparkable/chat/`), a
  dialog wrapping `<ResparkableChat>` with a new `entityContext` prop, launched
  from a "Tell me more" action on Area/Goal rows and the Project detail page.
  Areas and Goals have no `[id]` detail route, so a dialog avoided needing one;
  Projects get the same component for consistency rather than a bespoke inline
  block.
- **Freeform** — `/resparkable/context` (nav label "Talk"), the same
  `<ResparkableChat>` with no `entityContext`, so captures land unlinked.

Both send through the identical `resparkable_capture_context` capability — there
is no separate storage path for either.

### 3d. The description-summariser

`services/context-digest.ts` gathers, deterministically and with zero LLM
calls: the entity's own name/description, every `accepted` thought-link
touching it (either direction), thought content up to a per-note and total
character budget, excluding `sensitive` rows at the query level. Same shape as
`services/briefing.ts`: a pure gather function, a `tool_call` workflow step
(`resparkable_get_context_digest`), then exactly one LLM call.

That one call is `resparkable-summariser` (`capabilities/reviews.ts`'s existing
`resparkable_write_review`, unmodified), a new narrow agent bound to the gather
capability plus `writeReview` and nothing else — kept separate from
`resparkable-strategist`, on the same precedent phase 7 used for
`resparkable-briefer`: a narrow job with inputs already selected for it gets its
own agent. It writes a `ResparkableReview{horizon:'context_summary'}` proposal,
never the entity's `description` column directly.

The workflow, `resparkable-context-digest`
(`workflows/definitions.ts`), is **triggered, not scheduled** — same shape as
phase 9's `captureIntake`, except the trigger is
`POST .../[id]/summarize` (`api/handlers.ts#createSummarizeHandlers`) calling
`queueResparkableWorkflowRun` directly, rather than an inbound webhook. The
route checks entity ownership before queuing, so a request for an id that
isn't the caller's 404s immediately rather than queuing a run that fails a
minute later.

### 3e. Review, accept, dismiss — never a blind overwrite

`<ContextSummaryPanel>` (`components/resparkable/reviews/`) polls for a pending
`context_summary` proposal after queuing one (there's no push channel for a
queued workflow execution), and on finding one renders current-vs-proposed with
Accept/Dismiss:

- **Accept** `PATCH`es the entity through the _same, unmodified_ resource route
  the boring form already uses (`RESPARKABLE_API.itemPath`), then dismisses the
  review. There is no second write path for `description` — this is the single
  most load-bearing reuse point in the phase.
- **Dismiss** archives the review via a newly-bound route,
  `POST /reviews/[id]/dismiss`, which calls `repo/reviews.ts#archiveReview` — a
  function that already existed (used nowhere) because no route had ever
  exposed it.

## 4. Deliberately deferred

- **No periodic digest sweep.** Every other Release 1+ release ships a
  scheduled variant alongside its on-request one; this phase ships only the
  on-request path. A scheduled tick proposing summaries for entities with newly
  accepted thought-links is the natural next phase if this proves worth
  automating unprompted — noted in `plan.md` §15 as phase 44, not built here.
- **No agent-settable sensitivity escalation.** An earlier draft considered
  letting the capturing agent raise (never lower) a classification the
  heuristic missed. Skipped for now to keep the write path simple; the
  heuristic plus the existing user-correction path (`PATCH /thoughts/[id]`)
  covers the locked requirement (DB-level classification, human-correctable)
  without adding "escalate-only" validation semantics that had no second use
  yet.
- **`sensitivity` lives only on `ResparkableThought`.** Not added to
  Area/Goal/Project — the thing that needs gating is content flowing _into_ a
  description, which is enforced at the source (excluding sensitive thoughts
  from the summariser's corpus), not by classifying the entities themselves,
  which stay fully human-authored prose.

## 5. GDPR

No new table, so nothing changes in `lib/framework/resparkable/repo/subject-export.ts`'s
manifest — `sensitivity` is a new column on an already-registered model, and
that manifest exports via `omit` (deny-list), so it's included by default.
`tests/unit/lib/framework/resparkable/privacy/subject-export.test.ts` and
`tests/unit/lib/privacy/export-sources.test.ts` both still pass unchanged. No
new FK, no new cascade rule — the two new agents and two new capabilities are
seed data, same as every other agent/capability row.

## 6. Verification

- `npm run type-check`, targeted `eslint` over every changed file — both clean.
- `npm run db:migrate:dev` + `npm run db:drift-check` — the migration was
  regenerated once after Prisma's diff emitted DROP statements for the six
  drift-guarded raw-SQL objects (see the ⚠️ warning atop
  `framework-resparkable.prisma`); the six were restored and the migration file
  was hand-trimmed to the one additive `ALTER TABLE`, consistent with that
  file's own instruction.
- `npm run db:seed` — idempotent; a second run reports every unit unchanged.
- Full `lib/framework/resparkable` + seed + relevant API test suites green
  (2865 tests, 136 files), including three new unit-test files
  (`services/sensitivity.test.ts`, `services/context-digest.test.ts`,
  `capabilities/capture-context.test.ts`, `capabilities/context-digest.test.ts`)
  and mechanical updates to the capability-count, workflow-set, and
  ownerless-run sweep tests that assert exact totals across the whole
  catalogue/agent/workflow surface.
- Not yet done: a live end-to-end pass in the running app (open
  `/resparkable/context`, capture a few notes, run `/summarize` on a project,
  accept the proposal). Recommended before this ships to users.
