# Resparkable UI — the rules, and why each one exists

Everything under `app/(resparkable)/resparkable/**` and `components/resparkable/**`.

Read this before adding a surface. Every rule below is here because breaking it
produces a page that looks correct.

---

## 1. One enriched fetch per surface. Never one per row.

`CLAUDE.md` forbids per-row client fetches, and a second brain is where that rule
earns its keep: a dashboard of ranked tasks, each needing a project, each project
needing an area, is thirty requests and a page that assembles itself in front of
the user.

Every surface therefore has **one endpoint that returns everything it renders**:

| Surface     | Endpoint                          |
| ----------- | --------------------------------- |
| Today       | `/resparkable/today`              |
| Inbox       | `/resparkable/inbox`              |
| Project     | `/resparkable/projects/[id]/view` |
| Person      | `/resparkable/entities/[id]/view` |
| Card sheet  | `/resparkable/tasks/[id]/view`    |
| Board       | `/resparkable/boards/[id]/view`   |
| Connections | `/resparkable/connections`        |
| Graph       | `/resparkable/graph`              |
| Nav badges  | `/resparkable/counts`             |

**The query count must not move with the row count.** The route tests assert the
count directly, because an N+1 regression changes nothing you can see. If a new
field needs a query per row, batch it in the service — `hydrateLinks` and
`listTagsForTasks` are the shape to copy: collect ids across the whole batch,
then one query per type.

A page may issue **two or three** fetches for _page-level_ things — the option
list for a select, the tag library — as long as none is per row. Run them
concurrently.

## 2. Server components read. Client components mutate.

```
page.tsx (server)  → readResparkable(RESPARKABLE_API.X, schema) → pass `initial` down
view.tsx (client)  → apiClient.patch(...) → optimistic update
                   → SaveStatus (aria-live) → router.refresh()
```

**Pages read through the API, not through the services.** A server component
could call `buildToday(ownerScope(session.user.id))` directly and save a
localhost round trip. It doesn't, because that would create a second
implementation of "what does this surface show" — and the API is the contract the
agent layer and MCP will use too. One path, exercised by everything.

Failure is a **state**, not an exception: `readResparkable` returns a result, pages
render `<LoadError>`, and a failed option-list read degrades one dropdown rather
than taking down the page.

## 3. Wire shapes are parsed, never cast.

`lib/framework/resparkable/ui/payloads.ts` describes what arrives **after**
`JSON.stringify` — every `Date` is a string, every `undefined` is gone. A
component typed with a service's return type would be lying, and the lie surfaces
at runtime as `dueAt.getTime is not a function` rather than as a type error.

The schemas are deliberately **not** `.strict()`. During a rolling deploy the API
is briefly ahead of the client, and an unknown field must not blank a page.

## 4. Optimistic where it matters, with a real rollback.

Ticking a task, dragging a card, accepting a suggestion, capturing a thought.
Waiting on a round trip before the screen changes makes these feel broken.

Two rules:

- **Capture the previous state before the optimistic update, restore it
  wholesale on failure.** A partial rollback is how a board ends up disagreeing
  with the server in a way nobody notices until a refresh.
- **Never lose user input.** `QuickCapture` clears the textarea immediately and
  puts the text _back_ if the POST fails. That is the one unforgivable failure in
  this product. It is also why collapsing Sparkey to its rail doesn't unmount
  the composer underneath it (§10) — a stray collapse must not be able to bin a
  half-written thought.

## 5. Missing primitives are built here, not installed.

Sunrise ships no toast, skeleton, progress bar or generic data table, and Resparkable
deliberately adds none (`plan.md` §9):

| Need     | Instead                                                               |
| -------- | --------------------------------------------------------------------- |
| Toast    | `ui/save-status.tsx` — an `aria-live` status line next to the control |
| Skeleton | `ui/skeleton.tsx` — `animate-pulse` divs                              |
| Progress | `ui/progress-bar.tsx` — `role="progressbar"`                          |
| Table    | `components/ui/table.tsx` primitives, per surface                     |
| Radio    | `Select`                                                              |
| "Now"    | `ui/use-now.tsx` — see below                                          |

Three dependencies were added, all pre-approved: `d3-force` (graph layout),
`@dnd-kit/core` and `@dnd-kit/sortable` (the board, and the only reason it is
keyboard-operable).

## 6. Never read the clock during render.

`Date.now()` in a render body breaks `react-hooks/purity` **and** lets the server
and the browser disagree about what is overdue. Use `useNow()`: it returns `null`
until mounted, and callers treat `null` as "not yet known".

Err toward the neutral state — a task briefly _not_ flagged overdue is better
than one briefly flagged wrongly.

## 7. Say the thing that is otherwise invisible.

Several of this product's behaviours are silent when they misfire. The UI names
them, and these strings are not decoration:

- **A sweep that hit its cap** looks exactly like a sweep that found everything.
  `cappedTypes` is rendered prominently; so is the graph's `truncated`.
- **An expired pin** stops applying. `PriorityExplainer` reports
  `priorityFactors` verbatim and recomputes nothing — an expired boost arrives as
  `manualBoost: 0` with `boostActive: false`.
- **Archived items are keyword-searchable, not meaning-searchable**, because
  archiving deletes their embeddings.
- **A restored item** returns to meaning-search only after the next indexing pass.
- **Card aging names its own measurement.** "9d in Doing" is read from the card's
  last status-change event; "untouched 11d" is the fallback when there is no such
  event to read (a card never moved, or moved before that metadata existed). The two
  are worded differently on purpose — see `plan.md` §12's phase 5 note.

## 8. Accessibility rules that are easy to skip

- **Icon-only buttons need an `aria-label` that names the subject**, not just the
  verb: "Snooze this task", not "Snooze". These sit one per row.
- **Never nest a popover inside a dropdown menu.** Two focus traps, one inside
  the other; the inner field loses focus to the outer menu's typeahead. Make it a
  sibling control — `SnoozeMenu` does.
- **Never nest an interactive control inside a drag source.** Every click starts
  a drag first. The board's "Open" button sits outside the drag listeners.
- **A column must be its own drop target.** An empty column has no sortable
  children, so without `useDroppable` on the column a card can never enter an
  empty status — the first thing anyone does with a new board.

## 9. Forms

`react-hook-form` + Zod resolver, `mode: 'onTouched'`, and `<FieldHelp>` on every
non-trivial field. The dialog shell is `ui/resource-dialog.tsx`; **the caller owns
`useForm`** (a component generic over "some Zod schema" loses the input/output
relationship `zodResolver` needs, and the only escape is an `as`).

`toBody` stays per-form. The API schemas are `.strict()`, so "omit the field" and
"send null" are different requests — one leaves a value alone, the other clears
it — and only the form knows which an empty input means.

Help text says **what the field does to the system**, not what it is. "Which
domain of your life this belongs to" is a definition; "blocking time narrows the
gap `effortFit` compares your next task's estimate against" is the reason someone
would fill it in. Not every field has a mechanism behind it, though: Life's
`description` has none, deliberately (`design-principles.md`), and its help text
says so rather than inventing one.

## 10. The composer lives in Sparkey's own pane, not an overlay drawer

`components/resparkable/sparkey/composer.tsx`, mounted inside `SparkeyPane`
(`components/resparkable/sparkey/sparkey-pane.tsx`) — the left pane of the
three-pane shell (§14), not a full-height drawer floating above the page.
`resparkable-sidekick.tsx`, the fixed drawer this replaced at the Phase 8
cutover, is orphaned code today (referenced only by its own test) — the
drawer's actual job, a place to think that never narrows the page underneath
it, is now Sparkey's own docked pane: it sits beside the page rather than
over it, so it costs the tiled panes nothing to have open.

**Collapsing the pane parks it; it does not unmount it.** Sparkey collapses to
a thin `PaneRail` strip (§14) rather than disappearing. See §4: the
composer's draft, an attached file and an in-flight transcript all live in
that pane's own React state, which stays mounted the whole time — only which
of the pane's two JSX branches (full content vs. rail) renders changes.

**Three modes, one textarea.** Capture, Chat and Instruct (`ModeSelector`) all
send through the same `Composer`; only what happens to the submitted text
differs. Capture is a bare `POST /resparkable/thoughts`, deliberately never
touching the agent — a capture that can fail for a reason unrelated to saving
the words breaks this app's one rule above all others. Chat and Instruct both
ride `useChatStream` against the same `resparkable-companion` agent; Instruct
just renders the reply as a compact status card (`InstructReceipt`) instead of
a conversational bubble — a board-shaped instruction is declined locally,
before it ever reaches the agent, since no capability writes board membership
or card position yet.

**Three ways in, one destination.** Typing, dictating (`voice-capture-button.tsx`)
and dropping a file (`capture-attachment.tsx`) all end in the same textarea. None
of them posts anything on its own: dictation mishears, extracted document text
needs cutting down, and both stay drafts until a person presses Send. That is
what makes it safe for the easy paths to be this easy.

**A dropped file asks where it goes, and is never guessed at.** Two endpoints,
because they are two different promises:

| Choice            | Endpoint                         | What happens                                  |
| ----------------- | -------------------------------- | --------------------------------------------- |
| Read into capture | `/resparkable/documents/extract` | Parsed, text returned, **nothing stored**     |
| Add to Documents  | `/resparkable/documents`         | Hashed, deduped, embedded, searchable forever |

Guessing is a bad trade in both directions: guess "read" and the report someone
meant to keep is gone; guess "file" and their library fills with attachments they
only wanted to glance at. Extraction is capped at 20 000 characters and reports
`characters`/`truncated` for the whole document, so the UI can say what it left
out rather than passing off a third of a book as the whole thing.

**Voice reuses the platform's machinery but not its route or its component.**
`useVoiceRecording` and `MicLevelMeter` are imported as-is; `MicButton` is not,
because it requires an `agentId` and posts it, and the platform's transcribe
endpoint is `withAdminAuth`. `/resparkable/transcribe` resolves the companion agent
server-side for cost attribution only, and gates on the org-wide
`voiceInputGloballyEnabled` kill switch but **not** on any agent's
`enableVoiceInput` — that flag governs an agent's chat surface, and this
microphone addresses no agent.

---

## 11. The launcher

`components/resparkable/workspace/launcher.tsx` — what an empty pane shows,
not a persistent rail down the left of the shell. `resparkable-nav.tsx`, the
rail this replaced at the Phase 8 cutover, is orphaned code today (referenced
only by its own test and one `@see` comment) — the grouped-by-section
navigation it offered now lives here instead, opened per pane rather than
pinned to the shell's edge. A freshly split pane always opens on Launcher
(`splitLeaf` seeds a new leaf with no tabs); the tab strip's own "+" reaches
it from a pane that already has tabs open.

**Same four groups, a different surface.** The four groups (**Daily**,
**Organise**, **Knowledge**, **Manage**) are still the product's own model —
`RESPARKABLE_NAV_GROUPS`/`RESPARKABLE_NAV_ITEMS`
(`lib/framework/resparkable/ui/nav-groups.ts`) are unchanged and still the
single source of truth (`section-help.test.ts` still asserts every item has
help copy) — but Launcher renders them as a grid of tiles inside a workspace
pane, not as a rail that's always on screen. A tile is icon-over-label only,
no per-tile blurb: `<SectionHeader>` still shows that blurb once, on the page
a tile opens, rather than repeating it on every tile here too.

**"Ask Sparkey" is deliberately absent**, not filtered by accident:
`tab-registry.ts` has no `chat` kind, because Sparkey's own pane (§10) already
absorbs chat — `/resparkable/chat` is a redirect, not a destination page, from
the Phase 8 cutover on. Any nav item that doesn't resolve to a real tab kind
(via `resolveTabForPathname`) is skipped the same way, so Launcher can never
offer a tile that does nothing when clicked.

**The tile grid is a container query, not a viewport breakpoint.** `@container`
on Launcher's root div; `@sm:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4` on
the tile grid itself. The pane this renders inside can be anywhere from a
third of the screen (three-pane desktop, both side panes expanded) to the
whole viewport (a maximized single pane, or `MobilePaneSwitcher`), and a
viewport-keyed breakpoint would size the grid to the wrong thing — the screen,
not the box the grid is actually laid out in.

**Counts don't survive the move to a pane, and that's a deliberate upgrade, not
a gap.** The old rail's per-item badges (`/resparkable/counts`) have no reader
left in the new shell; Activity (§14) now surfaces pending connections as a
live, browsable feed instead of a number on a nav item.

---

## 12. Machine output is monospaced. Yours is not.

Anywhere the app is _talking to you_ — the chat transcript, the morning briefing
— and the prompt you type into it get `.terminal-surface`
([design-language.md](../../ui/design-language.md)), which switches the subtree to
JetBrains Mono and gives it the leading monospace needs at reading length.

**The line is who wrote it, not which component renders it.** `<MarkdownView>`
renders both an assistant reply and a note you typed, so the class goes on the
**call site**, never inside the component. Put it in `MarkdownView` and every
project description in the product turns into a terminal.

| Surface                       | Treatment                                                         |
| ----------------------------- | ----------------------------------------------------------------- |
| Chat transcript + composer    | `.terminal-surface` on the root — the whole exchange is a session |
| Capture box                   | `.terminal-surface` on the `<Textarea>` only                      |
| Morning briefing title + body | `.terminal-surface` on the prose, not the card                    |
| Thoughts, notes, descriptions | **Nothing** — this is your writing, it stays in Archivo           |

Scope it as tightly as the meaning goes. On capture that means the box and not
the form: what you type into a terminal is monospaced, the panel around it isn't,
and the attachment card and status notes below are the app addressing you. On the
briefing it means the two paragraphs the overnight workflow wrote — the staleness
warning above them is the app's own voice.

The admin orchestration chat
(`components/admin/orchestration/chat/chat-interface.tsx`) arrived at the same
treatment independently and still carries its own `font-mono`; it is
Resparkable-owned, so it is left alone rather than converted.

Streaming output ends in a `.terminal-caret` — the blinking block says the
program has the line and has not finished with it, which is the only thing you
want to know while waiting. It stops blinking under `prefers-reduced-motion`, and
the word beside it carries the meaning on its own.

---

## 13. The chat is one panel, and the wait explains itself

**One border around the transcript and the composer, with a divider between
them.** The exchange is a single object: the thing you type into is the bottom of
the thing you are reading, and a gap with the page showing through says
otherwise. `overflow-hidden` on the panel is what lets its corners clip the
scrolling transcript inside.

**The user's turn is a bubble; the assistant's is not.** Two near-identical greys
stacked down a transcript is a weaker signal than shape and alignment, and the
reply should read as the page rather than as a quote on it. A rule down the left
marks it as spoken by the app.

### Streaming is paced, not raw

The stream was always token-by-token, but providers send whatever their own
buffering produces — often a whole clause — so raw rendering arrives in slabs:
technically streaming, visually a series of jumps.

`useTypingAnimation` (`lib/hooks/` — platform-level, so the tier may import it,
unlike anything under `components/admin/`) sits between the deltas and the DOM
and releases the buffer at a fixed rate per frame. Two rules:

- **State holds the whole answer; the hook holds how much may be shown.** The
  renderer prefers `typing.displayText` for the last assistant turn while
  `streaming || typing.isAnimating`, then hands over to the settled message with
  no visible change.
- **Never `flush()` on the happy path.** The stream finishing is not the same
  event as the answer finishing being read; cutting the reveal short at `done`
  makes the last sentence of every reply snap into place. Flush and `reset()` are
  for `content_reset`, rollback, and teardown.

It is a paced reveal of text already received — nothing extra on the wire, and it
can never show a token the server did not send. Disabled under
`prefers-reduced-motion`: that preference asks for the content, not the
performance of it arriving.

### The wait says what it is doing

`<ThinkingIndicator>` renders while the live turn has no text yet — dots plus the
handler's own status string ("searching your brain"). A static word during a
ten-second tool call is indistinguishable from a hung page.

Status arriving _mid-answer_ gets a separate `aria-live` line, rendered only when
the indicator is not on screen. Two live regions carrying the same string
announce the event twice.

### Composer

`<AutoGrowTextarea>` (`components/resparkable/ui/`) — one row when empty, grows to
ten, scrolls past that. It measures `scrollHeight` after collapsing to `auto`
rather than counting newlines, because soft wrap makes counting wrong on a narrow
box. It also sets `min-h-0`: the base `<Textarea>` ships `min-h-[60px]`, and
`min-height` constrains `height` rather than losing to it.

Dictation reuses `<VoiceCaptureButton>` and lands the transcript **in the box**
rather than sending it — a transcript with a wrong word in it should be fixable
before it is asked.

---

## 14. The three-pane shell

`components/resparkable/shell/workspace-shell.tsx` — `SparkeyPane` (§10,
left), the workspace pane tree (tabs, splits, the tab-registry-backed
`RouteTabBridge`), and `ActivityPane` (the discovery feed, right), tiled with
`ResizablePanelGroup` (`components/ui/resizable.tsx`) rather than three
independently-scrolling regions of the page. `{children}` — whatever
`page.tsx` a route resolved to — becomes the tree's one route-backed tab via
`RouteTabBridge`, so every existing deep link, bookmark and email link still
resolves through normal Next navigation: the URL still does the routing, this
just also tells the tree which pane should show it. Below `lg` (1024px),
`MobilePaneSwitcher` renders the same route-bridged tree as a single
full-width pane instead of tiling it.

**Both side panes collapse to a rail, never to nothing.** `collapsedSize` on
each `ResizablePanel` is a few percent, not zero — collapsing takes Sparkey or
Activity to a thin, still-clickable `PaneRail`, not out of existence. Neither
pane unmounts either way, which is what keeps a collapsed Sparkey pane's
composer draft alive (§10). `PaneCollapseButton`, floating on the
`ResizableHandle` between panes, and clicking the rail itself both trigger the
same `.collapse()`/`.resize(22)` calls — never `.expand()`, which would
restore whatever size a manual drag left the panel at rather than a
predictable width.

**A tab can be dragged out of the tree entirely.** Detaching a tab (drag its
tab-strip pill) turns it into a `FloatingTabWindow` — a free-floating,
resizable window rendered above the whole shell by `FloatingPanelsLayer`,
hand-rolled on pointer events rather than a library (`react-resizable-panels`
only lays out panels docked within one group, and this is too small a job to
justify a dependency for it). Dragging its title bar re-docks it into
whichever pane the drop lands on; its own redock button is the only
_keyboard_-reachable way back in, since dragging has none.

**Present mode is a dialog, not a fourth panel.** `PresentPane`
(`components/resparkable/workspace/present/present-pane.tsx`), triggered from
the header's Present button, renders full-viewport inside `Dialog`/
`DialogContent` rather than a fourth `ResizablePanel` — a mode whose whole
point is _not_ sharing the screen doesn't belong in a layout built for sharing
it. Three sub-modes: Lightweight (nothing built, just a prompt to talk from),
Deck (built from a Graph tab's selected nodes), and On-the-fly (each dictated
sentence becomes one slide, appended and jumped to immediately — no model
call, the same "deliberately dumb" contract Capture mode holds elsewhere).
Deck mode consumes a Graph tab's payload as a prop; `WorkspaceShell` passes
`null` today rather than a live tab's data (wiring a focused Graph tab's
payload through is deferred — see that file's own header comment), which is a
real, already-handled state, not a stand-in for a crash: Deck's own empty
state says "Open a Graph tab and come back."

---

## Adding a surface — the checklist

1. Does an endpoint return **everything** the page renders? If not, add a `/view`
   sibling and a service that batches. Assert the query count.
2. Add its wire schema to `ui/payloads.ts`.
3. Server page: `readResparkable` → `<LoadError>` on failure → pass `initial` down.
4. Add the route to `RESPARKABLE_ROUTES` and, if it deserves one, a nav entry — into
   a group in `RESPARKABLE_NAV_GROUPS`, and a matching entry in `ui/section-help.ts`
   or its test fails.
5. Add a `loading.tsx` using `SkeletonList`.
6. Component tests for the behaviour that would look fine if wrong — optimistic
   rollback, request shape, and the copy that explains a silent behaviour.
