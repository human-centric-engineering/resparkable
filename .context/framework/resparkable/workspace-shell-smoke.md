# Workspace shell — manual smoke checklist

The Phase 8 cutover shipped with this checklist unrun (`workspace-shell-plan.md`
§ Verification says so plainly), and the two bugs found since — two stacked
headers, then a silently missing footer — were both caught by a person looking
at a screenshot rather than by any automated check. That is the gap this
document exists to close, and it is why it is a checklist to work through rather
than a suite to run: what is being checked is whether three panes look and feel
right, which no test asserts.

**Before you start**

```bash
npm run dev              # then open https://resparkable.test (not localhost:3016 — see dev-proxy.md)
```

Sign in with email/password. Google sign-in cannot work on a `.test` host.

**How to read this.** Each item names what to do and, separately, **what would
be wrong** — the failure worth looking for, not just "it works". Tick the ones
that pass; anything that doesn't, note it and it becomes the next pass's work.
Items marked **new** cover the 2026-08-22 consolidation pass and have never been
exercised by hand at all.

---

## The frame

**1. The shell renders.** Open `https://resparkable.test/resparkable`.

- One header, not two. One brand mark, one search box, one avatar menu.
- Three panes: Sparkey (left), Workspace with a Today tab (centre), Activity
  (right).
- The footer (copyright · Cookie Preferences · Help & Support) sits at the very
  bottom, with no gap above it.
- _Wrong:_ a second nav row above the shell; a strip of empty page below the
  panes; the honeycomb lattice showing through Sparkey or Activity (it belongs
  to the Launcher only).

**2. Panes collapse and restore.** Collapse Sparkey, then Activity, using each
pane's collapse control. Restore both from the thin rails.

- _Wrong:_ a collapsed pane vanishing with no rail to bring it back.

**3. Resize and persist.** Drag a divider, then reload the page.

- The layout comes back as you left it (`resparkable.workspace.v2` in
  localStorage).
- _Wrong:_ the drag feeling laggy or stuttering — the resize write is debounced
  at 150ms and should not be doing work per pointer tick.

**4. Narrow viewport.** Drag the window below ~900px.

- The three panes are replaced by a pane switcher, no console errors.
- _Known and accepted:_ a Sparkey draft in progress is lost crossing the
  breakpoint. Not a bug to report.

---

## Capture and Sparkey

**5. Capture lands.** In Sparkey, switch to Capture mode and capture a thought.
Open Inbox from the Launcher.

- The thought is there.

**6. Chat answers.** Switch to Chat mode, ask a question about your own
material.

- A reply streams in, and a chip names which tools ran if any did.

**7. Instruct acts.** Switch to Instruct mode, ask it to create a project.

- The project is created and the transcript says so.
- Then ask it to move a card on a board: it should refuse **specifically**
  ("not available through Sparkey yet"), not attempt it and fail.

**8. The mismatch prompt fires.** In Chat mode, type something plainly
capture-shaped ("buy milk"). In Capture mode, type something plainly
question-shaped ("what should I do today?").

- An inline, dismissible prompt suggests the other mode.
- _Wrong:_ it blocking the send. It must never do that.

**9. Edit through Sparkey, both ways.** Edit an existing Goal via Sparkey's chat
option, then switch that panel to its form option and edit again.

- State survives the switch between chat and form, and both writes land.

---

## Tabs and panes

**10. The Launcher opens things.** Open the Launcher and open Boards, Graph, and
a second Projects tab.

- **new:** the Inbox tile carries a count if you have un-triaged thoughts, and
  no badge at all if you don't. Connections carries no badge — that is
  deliberate, the Activity pane replaces it.

**11. A split opens empty.** Split a pane.

- The new pane shows the Launcher, **not** a copy of its sibling's tabs.

**12. Tabs reorder and close.** Drag a tab along the strip. Close one.

- Closing the active tab activates its right-hand neighbour, or its left if it
  was last.

**13. Floating windows.** Drag a tab out of the strip into the workspace. Move
it, resize it, redock it.

- The one `source: 'route'` tab (whichever matches the URL) refuses to float
  and snaps back. That is correct.

**14. Detail tabs name themselves. new** Open two different Projects from the
Projects list, and a Board.

- Each tab reads the real name ("Q3 Roadmap"), not the generic "Project".
- Open a Note tab and type a first line: the tab renames as you type.
- _Wrong:_ three tabs all reading "Project"; a tab flashing blank before its
  name appears.

**15. Two panes, one kind, independent filters. new** This is the single most
important item in this document — it is the regression the consolidation pass
was for.

- Open **Plan** in two panes. Step one to tomorrow. **The other must not
  move**, and the address bar must not change.
- Open **Projects** in two panes. Filter one to `paused`. The other stays on
  every project.
- Open **Search** in a tab, run a query, tick "Include archived". Results
  re-run **in that pane**; the address bar does not change.
- Reload. Each tab comes back on its own day / filter / checkbox.

**16. A mutation refreshes its own pane only. new** Open a Board in one pane and
Projects (or Today) in another.

- Drag a card between columns. The board updates; **the other pane does not
  flicker, refetch, or scroll**.
- Tick a checklist item in a card's detail sheet, and archive something from a
  list. Same rule: only the pane you acted in updates.
- _Wrong:_ any visible reflow in a pane you didn't touch. That was the old
  `router.refresh()` behaviour and is what this pass removed.

**17. A route-backed tab still refreshes properly. new** Navigate the browser
directly to `/resparkable/inbox` (address bar, not the Launcher), then triage a
thought there.

- The list updates. This tab is the deliberate exception: it renders the real
  server page and still uses `router.refresh()`.

---

## Activity, Present, and the ways in

**18. Discoveries accept and reject.** In Activity, expand a discovery's "why",
accept one, reject another.

- Both leave the feed.

**19. Present mode.** Open Present from the header. Build a deck from a node
selection, and try the dictated on-the-fly mode.

- With the network tab open: **no request to any chat or LLM endpoint.** Slides
  are assembled locally, by design.

**20. Deep links still resolve.**

- Visit `/resparkable/chat` — it must redirect, not 404.
- Click an `EntityChip`'s "see connections" link — a Graph tab opens focused on
  the right node.
- Visit `/resparkable/graph?focusType=project&focus=<a real id>` directly.

**21. The PWA share target.** On Android, share a page to the app. Or hit
`/resparkable/capture?text=hello` directly.

- The capture page works. It deliberately still uses `QuickCapture`, not
  Sparkey's composer.

---

## After the pass

Anything that failed goes into `workspace-shell-plan.md`'s deferred follow-ups
with what you saw, in the same shape as the entries already there: what is
wrong, and why it is wrong rather than merely different.
