# Resparkable Workspace Shell — Implementation Plan

Not yet phased into a Release (§15 of `plan.md`) or assigned a phase number — this is the implementation plan for the UI/UX redesign scoped in `plan.md` §9 (Sparkey / Workspace / Activity) and §22 (Present mode), written once that design was validated with the user against a standalone artifact prototype. Nothing described below has been built yet.

## Context

We prototyped a redesign of Resparkable's authenticated app shell as a standalone HTML/CSS/JS artifact and iterated on it with the user until they liked it: a persistent three-pane layout (**Sparkey** assistant pane / **Workspace** tabbed-and-splittable content pane / **Activity** discovery feed) replacing today's left nav rail + right capture drawer. This design direction is already recorded in `plan.md` §9 (scoped 2026-08-19) and §22 (Present mode). This build plan replaces `/resparkable`'s own shell, not Sunrise's global app chrome, and carries forward the brand "way home" link the old nav rail's head used to own — there is no separate header/footer block in the app today (the current `layout.tsx`'s own doc comment explains why one was deliberately removed).

Research (3 parallel codebase explorations + 1 design pass) surfaced that several things the artifact demonstrates have no real backend yet: there is no `resparkable-instruct` agent, no general Activity-feed read path, no learned-preference/affinity system, and Present mode is explicitly design-stage in `plan.md` §22.4. Four scope decisions were made with the user up front to keep this a layout/IA change rather than open-ended new-feature work:

1. **Instruct mode** routes through the existing `resparkable-companion` agent (already bound to the needed `resparkable_upsert_*`/capture/search/link/ideate/briefing capabilities) with a UI-level "instruct" framing. A dedicated `resparkable-instruct` agent and board-card-move capability (boards have zero write capability today) are explicit follow-ups, not built now.
2. **Activity pane** ships discoveries (proposed connections) only — fully real, reusing the existing `GET /connections` + `PATCH /links/:id` endpoints. System notices (briefing/vault/retention — not even wired via `logEvent()` today) and the learned "affinity" weighting (confirmed absent from the schema) are follow-ups.
3. **Present mode** ships the real mode-picker/deck-navigator/mic UI wired to real Graph selection state, but slide "generation" assembles content directly from selected note titles/snippets/rationale — no LLM call, no new capability. Real generation is a follow-up needing its own design pass per `plan.md` §22.4.
4. **Rollout** is a direct replacement of `app/(protected)/resparkable/layout.tsx`, not a feature-flagged parallel rollout — sequenced so the shipped product stays unchanged until one late cutover phase.

## Architecture

### State: one `WorkspaceProvider`, a pure split-tree, no event bus

`components/resparkable/workspace/workspace-context.tsx` creates a single context in the new `layout.tsx`, backed by `useLocalStorage<WorkspaceState>('resparkable.workspace.v1', DEFAULT_STATE)` (the existing SSR-safe, cross-tab-synced hook at `lib/hooks/use-local-storage.ts` — reused as-is, values must stay plain JSON, no functions/Dates).

The split tree is a small discriminated union in `lib/framework/resparkable/ui/workspace/split-tree.ts` — pure, framework-agnostic, unit-tested like `priority/score.ts`:

- `{ kind: 'leaf', tabs: TabState[], activeTabId, locked }`
- `{ kind: 'split', direction: 'horizontal'|'vertical', children: SplitNode[], sizes: number[] }`

`react-resizable-panels` (new dependency — no resizable primitive exists today, confirmed) supplies the drag math, min/max sizing, and collapse via `ResizablePanelGroup`/`ResizablePanel`/`ResizableHandle`; our state only tracks _what's open where_. A `WorkspacePaneTree` component walks the tree and emits nested panel groups, one recursion per `split` node — this is what makes "split a pane that's already split" arbitrarily deep for free, matching the artifact.

Cross-pane actions (Activity's "open in Today", Sparkey's "open in Graph") go through one function on the context: `openTab(kind, params?, { newSplit? })`, targeting `focusedLeafId` (dedupes against an existing identical tab). Sparkey and Activity sit inside the same `WorkspaceProvider` and call `useWorkspace().openTab(...)` directly — no custom events.

### Existing routes keep working: route-backed vs. launcher-opened tabs

Every existing `page.tsx` under `/resparkable/**` (25 routes: Today, Inbox, Projects, Goals, Areas, Boards, Documents, Entities, Connections, Graph, Vault, Settings, …) **stays untouched** — same server fetch, same `readResparkable`. The new `layout.tsx` wraps `{children}` in `components/resparkable/shell/route-tab-bridge.tsx`, which watches `usePathname()`/`useSearchParams()` and calls `openTab()` for whatever route is currently matched, tagged `source: 'route'` — its content _is_ `{children}`, the real SSR output. Only one route-sourced tab exists at a time (a fresh navigation replaces it, like a browser tab). A **launcher-opened** tab (no matching URL) has no route and uses a client-fetch adapter instead (see below).

This is what keeps every existing deep link alive for free: emails (`resparkable_notify` links to `TODAY`/`GOALS`/`CONNECTIONS` only — confirmed, nothing links to `/resparkable/chat`), `EntityChip`'s "see connections" link, bookmarks — all keep resolving through normal Next navigation, now rendered inside the new pane frame. `/resparkable/chat` is retired with a one-line `redirect(RESPARKABLE_ROUTES.TODAY)` since Sparkey absorbs chat.

`SectionHeader` (`components/resparkable/layout/section-header.tsx`) is reused, not replaced — generalize it to accept an optional `href` override (default `usePathname()`); route-backed tabs render it unchanged, launcher tabs pass `href` explicitly.

### Tab content adapters (launcher-opened tabs)

No SWR/React Query exists in this codebase — the established client-fetch pattern (`components/resparkable/reviews/context-summary-panel.tsx`) is `apiClient.get<unknown>(...)` parsed by a Zod schema from `lib/framework/resparkable/ui/payloads.ts` (which exists specifically so client components can validate data without importing the server-only `server-read.ts` — see that file's own header comment) inside a `useEffect`. Every adapter in `components/resparkable/workspace/tabs/*-tab.tsx` follows this shape, then renders the **existing, unmodified** view component (`TodayTab`→`TodayView`, `GoalsTab`→`GoalsView`, etc.). Two need real new work: `GraphTab` (client-fetches `graphPayloadSchema`, renders `GraphView` unchanged) and `BoardTab` (ports the board-slug→view→tags fetch sequence `boards/[slug]/page.tsx` does server-side into three client calls, renders `BoardView` unchanged — its dnd-kit wiring needs zero changes). `NoteTab` is the one genuinely new component: manual hand-edit of a thought/note body via `apiClient.patch`, debounced, distinct from the existing AI-mediated description-summariser flow.

### The composer's mode-mismatch classifier: heuristic, not a model call

`lib/framework/resparkable/ui/workspace/classify-intent.ts` — a pure, table-tested function `classify(text): 'chat'|'capture'|'instruct'` using cheap surface signals (leading interrogative/trailing `?` → chat; leading imperative verb → instruct; otherwise → capture, the safe default that never loses a thought). No network call, matching Capture's own "deliberately dumb, no model call" design and the codebase's D3/D4 cost discipline (background/ambient checks stay off paid hot paths). A mismatch renders a dismissible inline prompt, never a hard block.

### Sparkey pane: unify chat/capture/instruct, extend chat-or-form duality to edit

`components/resparkable/sparkey/` hosts the composer (reusing `VoiceCaptureButton`/`ImageCaptureButton` as-is), a 3-way mode selector (Chat/Capture/Instruct — no separate Auto toggle), and one scrolling transcript rendering chat replies + capture receipts + instruct receipts inline. Chat streaming reuses the existing `parseChatStreamEvent` SSE contract (`components/admin/orchestration/chat/chat-events.ts`) lifted out of `resparkable-chat.tsx` into a shared hook.

The existing chat-or-form duality (`create-dialog.tsx`'s `inert`/`w-[200%]`-sliding-pane technique, `CreateModeToggle`, `ResourceFormBody` in `resource-dialog.tsx`) covers **create** only today — `entity-form-dialog.tsx` explicitly routes edit to form-only. `components/resparkable/sparkey/entity-editor-panel.tsx` adapts that same technique into a **non-modal** panel (no `Dialog` chrome) offering chat-or-form for **edit** too, binding chat to `resparkable-companion` (already holds the needed `resparkable_upsert_*` capabilities — no new agent required).

Board-shaped instruct requests ("move X to Doing") get an explicit "not available through Sparkey yet" response rather than a doomed tool call, since no board-write capability exists.

### Activity pane

`components/resparkable/activity/` client-fetches `GET /api/v1/resparkable/connections` (same schema `connections-view.tsx` already validates against) and reuses `PATCH /links/:id` for accept/reject, with local optimistic removal matching the existing `ConnectionsView` behavior. `discovery-card.tsx` adds the new "expand to see why" interaction using `components/ui/accordion.tsx` (shadcn primitive, confirmed unused in resparkable feature code today), visually matched to `thought-card.tsx`. Data shape (`ActivityItem = { kind: 'discovery', ...ConnectionRowWire }`) leaves room for a later `{kind:'event'}`/`{kind:'notice'}` union member without a rework, but only `discovery` is built now.

### Present mode

`components/resparkable/workspace/present/` — mode-picker, deck navigator, mic button (reusing `useVoiceRecording`), wired to real Graph selection state. `buildSlidesFromSelection()` is a pure, unit-tested function assembling slides from selected node titles/snippets/`ResparkableLink.rationale` — no LLM call. Presentation state is ephemeral (held in `WorkspaceProvider`), not a new Prisma model.

## New files (directory convention)

```
components/resparkable/shell/             top app-header, mobile pane-switcher, route-tab bridge
components/resparkable/sparkey/           composer, mode selector, transcript, entity-editor-panel
components/resparkable/workspace/         split tree UI, tab strip, launcher, toolbar
components/resparkable/workspace/tabs/    one client-fetch adapter per tab kind
components/resparkable/workspace/present/ Present mode UI
components/resparkable/activity/          discovery feed, expand/why card
lib/framework/resparkable/ui/workspace/   split-tree.ts, tab-registry.ts, classify-intent.ts (pure, unit-tested)
lib/framework/resparkable/ui/nav-groups.ts   extracted from resparkable-nav.tsx (Phase 0)
```

## Phased sequence

Phases 0–7 only add/refactor files nothing in the live route yet imports — the shipped product is unchanged until Phase 8. Commit per phase, each independently verifiable (`npm run validate` + new tests), matching this repo's own established phasing discipline.

- **Phase 0 — Groundwork, zero visual change.** `npm install react-resizable-panels`; add `components/ui/resizable.tsx`. Extract `RESPARKABLE_NAV_GROUPS`/`RESPARKABLE_NAV_ITEMS` out of `resparkable-nav.tsx` into new `lib/framework/resparkable/ui/nav-groups.ts`; `resparkable-nav.tsx` and `section-header.tsx` re-import from there. Update `section-help.test.ts`'s import accordingly. This is what lets the rail be deleted later (Phase 9) without breaking `section-help.test.ts`'s coverage invariant.
- **Phase 1 — Workspace state (pure, no UI).** `split-tree.ts`, `tab-registry.ts`, `classify-intent.ts`, `workspace-context.tsx` (`WorkspaceProvider`/`useWorkspace`). Table tests only.
- **Phase 2 — Workspace pane UI.** `workspace-pane-tree.tsx`, `tab-strip.tsx` (closeable/reorderable via `@dnd-kit/sortable`, same pattern as `task-card.tsx`'s board drag), `launcher.tsx` (grouped via `nav-groups.ts` + `RESPARKABLE_SECTION_HELP`), `toolbar.tsx`. A freshly split pane opens to the launcher, never a clone (enforced by `splitLeaf` initializing `tabs: []`).
- **Phase 3 — Tab content adapters.** One file per view kind under `workspace/tabs/`; `GraphTab`/`BoardTab` get the extra client-fetch-sequencing work described above; `NoteTab` is new.
- **Phase 4 — Sparkey pane.** Composer, mode selector, transcript, mismatch prompt, inspire-me toggle, `entity-editor-panel.tsx` (chat-or-form for edit).
- **Phase 5 — Activity pane.** Feed shell + `discovery-card.tsx`.
- **Phase 6 — Top app-header.** `app-header.tsx` — brand mark as way-home link, compact search (restyled `resparkable-search-box.tsx`, submits into a route-backed Search tab), theme toggle. `.lattice-chrome` styling per design-language.md.
- **Phase 7 — Present mode.** Mode-picker, deck navigator, `buildSlidesFromSelection()`.
- **Phase 8 — Cutover (the one PR that changes what `/resparkable` renders).** Rewrite `layout.tsx`: `AppHeader` + `ResizablePanelGroup` of `SparkeyPane` / `route-tab-bridge`-wrapped `WorkspacePaneTree` / `ActivityPane`, inside `WorkspaceProvider`; mobile fallback below ~900px (three-way pane switcher, same pattern as the rail's existing `lg:hidden` dropdown). `chat/page.tsx` → one-line redirect. Every other route page is untouched.
- **Phase 9 — Cleanup.** Delete `resparkable-nav.tsx`, `resparkable-sidekick.tsx`, and their tests. **Keep `quick-capture.tsx`** — it's still the dedicated component for `capture/page.tsx` (the Android PWA share-target landing page, confirmed via direct read: a simple full-page capture box reached via the Web Share Target API, unrelated to the drawer). Sparkey's own Capture mode posts to the same `RESPARKABLE_API.THOUGHTS` endpoint independently (a one-line POST) rather than depending on `QuickCapture`, so this stays a clean, low-risk split rather than forcing the share-target page through the new composer's chat/mode machinery. Relocate or delete `resparkable-search-box.tsx`/its test depending on Phase 6's choice. Remove the retired "Ask Sparkey" entry from `section-help.ts` (Chat is no longer a launcher destination).

## Risks

- **`section-help.test.ts` / `resparkable-nav.test.tsx` / `resparkable-sidekick.test.tsx`** — first two handled by Phase 0's extraction; the latter two are deleted with their subjects in Phase 9, not adapted.
- **`capture/page.tsx`'s dependency on `QuickCapture`** — resolved above (kept alive, not deleted).
- **Mobile/narrow-viewport fallback is real scope**, not droppable — three fixed panes can't compress below ~900px; must land in Phase 8, mirroring the existing rail's own `lg:hidden` precedent.
- **Two independently-fetched tabs on the same Graph focus/Board id is correct** (two views, like opening a URL twice) — worth a code comment so it isn't "fixed" into an unwanted shared cache later.
- **Instruct-mode board actions must fail loudly and specifically** (Phase 4's explicit "not supported yet" branch), not silently attempt an unbound tool call.
- **The "Honeycomb" rename** (`plan.md` §9's Graph→"Honeycomb view", "the brain"→"The Honeycomb") is available but deliberately **not adopted** here — it's a copy/branding change touching routes, nav, `section-help.ts`, and tests for no functional dependency on this build. Flag as an independent follow-up.
- **`EntityFormDialog` gaining a chat option on edit** — re-confirm at Phase 4 time that nothing outside Resparkable has started importing it (grep showed Resparkable-only at research time).

## Deferred follow-ups (recorded during implementation, Phases 0–4)

Scope decisions made while building, not present in the original plan text above. None block Phase 8's cutover; each needs its own pass rather than being folded into whichever phase happened to surface it.

- **The "inspire-me toggle"** (Phase 4's own bullet list) — **deferred outright**, per an explicit user decision when asked. The backend `ideate` endpoint (`POST /resparkable/ideate`) it would sit on has zero existing frontend callers anywhere in the codebase and requires a specific seed item (`seedType`+`seedId`) a general-purpose composer doesn't naturally have. Needs its own design pass: what supplies the seed, and what the toggle actually does.
- **`resparkable-chat.tsx` was not retrofitted onto `useChatStream`.** Phase 4 lifted the SSE fetch/parse loop out of it into a shared, callback-based hook (`components/resparkable/chat/use-chat-stream.ts`) so Sparkey's unified transcript could drive the same stream — but `resparkable-chat.tsx` itself still carries its own duplicate copy of that logic. It already ships with its own passing test suite and nothing about building Sparkey required changing it; retrofitting it onto the shared hook is a reasonable, low-risk follow-up, not bundled in.
- **`GraphTab` has no depth/node-cap picker.** The plan's own Phase 3 wording names only `GraphView` as reused, not `GraphControls` — and `GraphControls` reads/writes the real browser URL (`useSearchParams()`/`router.push`) to change depth, which is incompatible with a launcher-opened tab that has no 1:1 URL of its own. `GraphTab` fetches at the API's default depth/limit with no way to adjust either. A real picker needs its own design (local per-tab state, presumably), not a silent gap.
- **Several reused View components keep their own router-based controls inside a tab** — `ProjectsView`'s status filter, `DayPlanner`'s day navigation, `SearchResults`' include-archived checkbox all still call `router.push()` on the real browser URL when changed. Accepted as a known rough edge for every kind except Graph and Board (the two the plan explicitly calls out for real work) — changing a filter inside one of these tabs will navigate the actual page URL rather than staying pane-local. Worth a dedicated pass once more of the shell is live and the UX cost is easier to judge for real.
- **`ConnectionsTab`'s `total` under-counts past its `limit=50`.** The server page computes `total = meta.total ?? data.length`; `apiClient.get()` (`lib/api/client.ts`) discards the response envelope's `meta` field for every caller in the app, not only here, so a client-fetched Connections tab can only ever report `data.length`. Fixing it means changing what `apiClient.get()` returns everywhere — out of scope for one tab adapter, flagged in `connections-tab.tsx`'s own header comment.

## Verification

- `npm run validate` after every phase.
- Suites that must stay green throughout: `resparkable-nav.test.tsx` (until Phase 9), `resparkable-search-box.test.tsx` (relocate assertions in Phase 8), `section-help.test.ts` (import swapped Phase 0), all `*-view.test.tsx` (the underlying view components are reused unmodified, so these remain valid regression coverage for the new tab adapters).
- New tests per phase: table tests for `split-tree.ts`/`classify-intent.ts`/`buildSlidesFromSelection()`; component tests for every new interactive piece (mode selector, mismatch prompt, tab strip drag/close, launcher, discovery card expand/accept/reject, entity-editor-panel chat↔form state preservation).
- Manual smoke checklist for Phase 8 (UI-heavy, won't be fully covered by automated tests):
  1. Open `/resparkable` — header, Sparkey, Workspace (Today tab, route-backed), Activity all render.
  2. Capture a thought via Sparkey in Capture mode; confirm it lands in Inbox.
  3. Chat mode: ask a question. Instruct mode: ask it to create a project. Confirm the mismatch prompt fires when mode and content disagree.
  4. Open the launcher, open Boards + Graph + a second Projects tab; confirm a freshly split pane opens to the launcher, not a clone.
  5. Drag-reorder a tab; close a tab; drag a resize handle; reload and confirm layout persisted (`resparkable.workspace.v1` in localStorage).
  6. In Activity, expand a discovery's rationale, accept one and reject another; confirm both disappear and `PATCH /links/:id` fired.
  7. Edit an existing Goal via Sparkey's chat option, then via the form option; confirm state isn't lost switching between them and both writes land.
  8. Open Present mode, generate slides from a selection; confirm no network call to a chat/LLM endpoint (check the network tab).
  9. Resize below ~900px; confirm the pane-switcher fallback replaces the three-pane layout with no console errors.
  10. Visit `/resparkable/chat` directly — confirm redirect. Click an `EntityChip`'s "see connections" link — confirm it opens a correctly-focused Graph tab.
  11. Share a page to the app on Android (or hit `/resparkable/capture?text=...` directly) — confirm the PWA share-target page still works via the retained `QuickCapture`.

### Critical files

- `app/(protected)/resparkable/layout.tsx` — rewritten in Phase 8; everything else is scaffolding around it.
- `components/resparkable/layout/resparkable-nav.tsx` — source of `RESPARKABLE_NAV_GROUPS`, extracted in Phase 0.
- `lib/framework/resparkable/ui/section-help.ts`, `lib/framework/resparkable/ui/routes.ts` — reused registries for launcher/tab titles.
- `lib/framework/resparkable/ui/payloads.ts` / `server-read.ts` — schemas feeding every tab adapter; read both, the header comments explain the split.
- `components/resparkable/creation/create-dialog.tsx`, `entity-form-dialog.tsx` — the chat/form technique Sparkey's edit panel adapts.
- `components/resparkable/chat/resparkable-chat.tsx` — source of the SSE-handling logic Sparkey's transcript lifts out.
- `app/(protected)/resparkable/capture/page.tsx` — confirms the `QuickCapture` retention decision in Phase 9.
