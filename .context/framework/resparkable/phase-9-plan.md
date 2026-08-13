# Phase 9 — the phone, and the closing of Release 1

**Status: landed, 2026-08-13.** Phases 0–8 and 7b were already landed
(`README.md` §Status); phase 9 closes Release 1 (`plan.md` §15) — every later
release (sharing, vault sync, live folder sync, Cross-Pollination, Instruct
mode, Situations) is now optional and additive against data Release 1 has
already written. §7 records what landed differently from this document.

Phase 9's deliverable, from `plan.md` §15 row 9: **PWA manifest/icons/share-target

- voice capture (`useVoiceRecording` + `transcribe`) + image capture + an
  `AiApiKey` `resparkable` scope for iOS Shortcuts + a Postmark inbound trigger +
  the `resparkable_capture_for_token` capability.** Verifiable by: `curl` inbound +
  Chrome installability + `npm run smoke:transcribe`; record a thought on a phone
  and find it by meaning.

Like phase 7, this plan needed correcting before it could be built — four of the
six items in that row describe something other than what actually exists today.
Those corrections are §1, verified against source rather than against the plan's
own account of itself.

---

## 1. Four corrections to the phase 9 row

### 1a. Voice capture already shipped — quietly, and not the way `plan.md` describes

`plan.md` §7/§8 specify `POST /resparkable/capture/voice`: an endpoint that
accepts an audio blob, transcribes it, and creates a `ResparkableThought` with
`source: 'voice'` server-side.

That was never built, and something better was built in its place, unannounced
by any phase doc. `POST /api/v1/resparkable/transcribe`
(`app/api/v1/resparkable/transcribe/route.ts`) takes the audio, calls
`getAudioProvider().transcribe()`, and returns **text**, which
`VoiceCaptureButton` (`components/resparkable/layout/voice-capture-button.tsx`)
hands back to `QuickCapture` to `append()` into the textarea — same destination
as a dropped file's extracted text. The audio is never persisted (the route's
own audit-invariant comment says so); the transcript is a draft the user edits
before pressing Capture, same as everything else in the box. This is a better
design than the plan's — it doesn't need a new `source` value to distinguish
"typed" from "dictated-then-edited-then-typed", because by the time it's saved
it's just what's in the box — and `npm run smoke:transcribe` already exists and
passes.

**What's actually missing is smaller than "build voice capture": `THOUGHT_SOURCES`
already lists `voice` and `image` (`validations.ts:39-49`), but nothing sets
them.** `QuickCapture.submit()` posts `{ content }` only
(`quick-capture.tsx`, the `apiClient.post(RESPARKABLE_API.THOUGHTS, { body: {
content } })` call) — every capture from the web, whether typed, dictated, or
extracted from a document, lands as `source: 'web'`. That is a real gap against
plan.md §8's stated goal ("`ResparkableThought.source` therefore becomes `web |
pwa | voice | image | shortcut | email | chat | agent | api`") and it's worth
closing, but it's a one-property wiring fix (§3, 9.1), not a build item.

### 1b. Image capture is not "the same story" as voice — it has no ready-made primitive

`plan.md` §7 says image capture is free the same way voice is: `enableImageInput`,
a vision-capable model, `npm run smoke:vision`, and a photo becomes a thought.

Voice has `LlmProvider.transcribe()` — a single, purpose-built method any route
can call. **Vision has no equivalent.** `enableImageInput` /
`imageInputGloballyEnabled` and the vision-capable model check
(`assertModelSupportsAttachments`, exercised by `smoke:vision`) only exist
**inside the full chat/conversation path** — `lib/orchestration/chat/streaming-handler.ts`
gates attachments on a resolved `AiAgent`, builds `AiConversation`/`AiMessage`
rows, and folds the image into a persisted turn. There is no `describeImage()`
callable the way `transcribe()` is.

What _is_ reusable, one level down: `LlmProvider.chat(messages, options)`
(`lib/orchestration/llm/provider.ts:96`) is a generic one-shot completion, and
`ContentPart` (`openai-compatible.ts:572-587`) already carries the
`image_url`/base64 shape the streaming handler builds for attachments. So a
one-shot image-extraction route is buildable — compose `chat()` directly with a
single `{ role: 'user', content: [imagePart, textPart] }` message and a fixed
extraction instruction, mirroring `transcribe`'s route shape (validate upload →
resolve a vision-capable model → one non-streaming provider call → cost-log →
return text, nothing persisted) — but it is **new code**, not a wire-up. Budget
it like a small route, not a checkbox.

### 1c. The `AiApiKey` `resparkable` scope cannot be built from this tier — and doesn't need to be

This is the corrected item that changes the phase-9 row the most.
`AiApiKey.scopes` is a closed enum pinned in **two Sunrise-owned files**:
`lib/auth/api-keys.ts:18-20` (`ApiKeyScope` union + `VALID_SCOPES`) and
`lib/validations/orchestration.ts:3801` (`createApiKeySchema`'s
`z.enum([...])`). Resparkable does not edit Sunrise-owned files (CLAUDE.md; the
same rule phase 7 stated for `emails/`), so a narrow `resparkable` scope is not
something phase 9 can add.

This is already known and already tracked: **`sunrise-asks.md` #34
([sunrise#542](https://github.com/human-centric-engineering/sunrise/issues/542))**
names exactly this gap. And critically, **the capture flow the scope was meant
to gate already ships** — `install.md` §4.3 documents minting a `chat`-scoped
`AiApiKey` from the browser console and posting to
`/api/v1/resparkable/capture` from an iOS Shortcut, because `withAuth` accepts a
key of any scope. The doc states the accepted risk inline: _"the key on your
phone reaches every authenticated route as you, not just capture... give it an
`expiresAt`, and revoke it if the phone goes missing."_

**Phase 9 does no work here.** The Shortcut capture path is done (shipped in
phase 7b, per `install.md`'s own `_(phase 7b)_` heading — the plan's phasing and
the install guide's phasing have already diverged on this one item). The row
survives only as "confirm ask #34/#542 is still open, and do not attempt a
workaround" — forking `lib/auth/api-keys.ts` to unblock one tier would be
exactly the core-file edit the tier's whole design avoids.

### 1d. The PWA's own share-target destination doesn't exist yet

`plan.md` §8 specifies the share target as `method: 'GET'` →
`/resparkable/capture`. That path is not a route today —
`app/(protected)/resparkable/` has fourteen surfaces (`README.md` §Status) and
`capture/` is not one of them. `POST /api/v1/resparkable/capture` (the API
route) and the embedded `QuickCapture` widget both exist; the **page** the share
sheet is supposed to land on does not. The manifest can't be wired to a
`share_target` that 404s, so this page is a phase-9 prerequisite, not a detail
of the manifest step.

---

## 2. What is already in place

Verified present, so phase 9 builds on it rather than around it.

| Needed                                                                      | Where                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recording UI + MIME negotiation + 3-min cap                                 | `lib/hooks/use-voice-recording.ts` — `useVoiceRecording()`                                                                                                                                                                                                                                                                                                                         |
| Voice transcription route, cost-logged, no persistence                      | `app/api/v1/resparkable/transcribe/route.ts`                                                                                                                                                                                                                                                                                                                                       |
| Voice capture button, wired into the capture box                            | `components/resparkable/layout/voice-capture-button.tsx` → `quick-capture.tsx`                                                                                                                                                                                                                                                                                                     |
| The `source` enum, fully populated since phase 1                            | `THOUGHT_SOURCES` — `web \| pwa \| voice \| image \| shortcut \| email \| chat \| agent \| api \| vault` (`validations.ts:39`)                                                                                                                                                                                                                                                     |
| The capture front door, idempotent                                          | `POST /api/v1/resparkable/capture` (`app/api/v1/resparkable/capture/route.ts`) → `captureThought()`, dedupes on `externalId`                                                                                                                                                                                                                                                       |
| The email-routing token, already on the schema                              | `ResparkableSpace.inboxToken` (`framework-resparkable.prisma:65`), generated at space creation (`services/space.ts:75`), looked up by `findSpaceByToken` (`repo/space.ts:22-23`) — the field `plan.md` §7 describes as needing minting already exists and is already redacted from every export/API surface (`repo/subject-export.ts:88`, `app/api/v1/resparkable/space/route.ts`) |
| Generic inbound-trigger transport (Postmark, Slack, Twilio, WhatsApp, HMAC) | `lib/orchestration/inbound/**`, `app/api/v1/inbound/[channel]/[slug]/route.ts` — self-registers on env-var presence, zero Resparkable code needed for the transport itself                                                                                                                                                                                                         |
| Postmark adapter specifically                                               | `lib/orchestration/inbound/adapters/postmark.ts` — Basic-auth constant-time compare, `MessageID` dedup, normalises `MailboxHash`                                                                                                                                                                                                                                                   |
| Setup recipe for a new inbound channel                                      | `.context/orchestration/inbound-triggers.md` §Postmark — env vars, DNS, one `AiWorkflowTrigger` row                                                                                                                                                                                                                                                                                |
| Rate-limit sub-cap precedent to copy                                        | `lib/framework/resparkable/rate-limit.ts` — `resparkable-audio` (10/min, session-keyed) is the exact shape a new `resparkable-image` cap should follow                                                                                                                                                                                                                             |
| `AiApiKey` erasure + export coverage                                        | `onDelete: Cascade` on `AiApiKey.user` (`orchestration-providers.prisma:152`); already in `SUBJECT_DATA_SOURCES` with `keyHash` omitted (`lib/privacy/export-sources.ts:180-189`) — no new privacy work for the key model itself                                                                                                                                                   |
| Multimodal completion primitive                                             | `LlmProvider.chat()` + `ContentPart` (image_url/base64) — the layer image capture composes against (§1b)                                                                                                                                                                                                                                                                           |
| Chat-addressable agent allowlist, the seam the intake agent must stay off   | `RESPARKABLE_CHAT_AGENT_SLUGS` (`agents.ts:64`) — currently `[companion]` only; the chat route validates against it                                                                                                                                                                                                                                                                |
| iOS Shortcut recipe                                                         | `install.md` §4.3 — done, on the `chat` scope, pending ask #34/#542                                                                                                                                                                                                                                                                                                                |

---

## 3. The build, in order

### 9.1 — Close the source-attribution gap

`QuickCapture` tracks _how_ the current draft's content arrived (typed, or the
last dictation/extraction appended) and sends it as `source` on submit, instead
of always omitting the field. Small, pure client-side change; no schema, no
migration — `captureSchema`/`createThoughtSchema` already accept every value in
`THOUGHT_SOURCES`. Lands first because 9.2's image button needs the same wiring
and should follow the pattern this establishes rather than inventing its own.

### 9.2 — Image capture

The new route: `POST /api/v1/resparkable/capture/image` (or `/transcribe/image`
— name it alongside the existing transcribe route so the pairing reads clearly).
Validates the upload the same way `validateTranscribeUpload` does for audio
(reuse `enforceContentLengthCap`; the platform's upload ceiling is the right
default rather than inventing a new one), resolves a vision-capable model,
issues one non-streaming `LlmProvider.chat()` call with the image as a
`ContentPart` and a fixed extraction instruction ("describe what's readable in
this image — text, handwriting, a diagram — as plain text a person would jot
down"), cost-logs it via `logCost` attributed to `resparkable-companion` (same
attribution choice `transcribe`'s header explains), and returns text. **The
original photo is not persisted** — the same choice voice capture already made
("keeping the transcript, not the audio"), and the one this correction insists
on explicitly: `plan.md` §7's "original via `lib/storage`" line is superseded
for the same reason §1a's server-side-thought design was. An image someone
photographed to jot a note from is not a document they meant to file; if they
want the file kept, "Add to Documents" already exists via `AttachButton` for
exactly that.

Gates on `imageInputGloballyEnabled` (the org-wide kill switch, same role
`voiceInputGloballyEnabled` plays for transcribe) — **not** on any agent's
`enableImageInput`, for the same reasoning the transcribe route's own header
gives for skipping `enableVoiceInput`: this isn't a chat surface, no agent is
being addressed, and gating a capture-box affordance on a chat-turn flag would
default it off on every install.

`ImageCaptureButton` (`components/resparkable/layout/`) mirrors
`VoiceCaptureButton`'s shape: a camera icon, `capture="environment"` on the file
input so mobile opens the camera rather than the gallery picker, extracted text
`append()`ed into the textarea exactly like a transcript. Wire it into
`quick-capture.tsx` next to `AttachButton`, and set `source: 'image'` per 9.1's
mechanism when the last append came from it.

New rate-limit sub-cap: `resparkable-image`, matching `resparkable-audio`'s
shape (10/min, session-keyed) in `lib/framework/resparkable/rate-limit.ts` —
same reasoning, a paid per-call vision request rather than a per-second
interaction.

### 9.3 — The capture-intake workflow

Deferred here from phase 7 (`phase-7-plan.md` item 3: `resparkable-capture-intake`
"triggers on `resparkable_capture_for_token`, which is a phase 9 capability").
Three pieces, built in dependency order:

1. **`resparkable_capture_for_token` capability** — the one deliberate exception
   to "`userId` always from `context`" (`plan.md` §8's own framing). Takes
   `{ inboxToken, from, subject, text, messageId }`, resolves `userId` via
   `findSpaceByToken`/`findSpaceByInboxToken` (already built, §2), and **ignores
   `context.userId`**. Mandatory compensating controls, per `plan.md` §8:
   - bound to _only_ the intake agent (below) — never `resparkable-companion`,
     never reachable from chat or MCP;
   - rejects unless `from` matches the resolved user's verified account email;
   - `messageId` (Postmark's `MessageID`, already deduped once by the adapter)
     is also checked against `captureThought`'s own `externalId` dedupe, so a
     redelivered webhook can't double-file.
2. **An intake agent** — a seventh slug added to `RESPARKABLE_AGENT_SLUGS`
   (`agents.ts:23`), bound to exactly this one capability. **Do not add it to
   `RESPARKABLE_CHAT_AGENT_SLUGS`** (`agents.ts:64`) — that allowlist is the
   security boundary the file's own comment names, and this agent's whole reason
   to exist is a capability chat must never reach.
3. **`resparkable-capture-intake` workflow** + one `AiWorkflowTrigger` row with
   `channel: 'postmark'` (per `.context/orchestration/inbound-triggers.md`
   §Postmark — no route code, the adapter already exists). Set
   `maxCostPerExecutionUsd`, same rule phase 7's §7.4 stated for the other four
   workflows.

Env vars: `POSTMARK_INBOUND_USER` / `POSTMARK_INBOUND_PASS` (generic, already
read by the platform adapter) and `RESPARKABLE_INBOX_DOMAIN` (Resparkable's own —
already documented as reserved for this phase in `lib/framework/resparkable/env.ts:20`,
currently an empty schema).

**Document loudly**, per `plan.md` §8's instruction. The plan names
`.context/framework/resparkable/second-brain.md`, which doesn't exist. Write
`.context/framework/resparkable/capture-channels.md` instead — one file per
capture path (web, PWA, voice, image, shortcut, email, chat), the inbox-token
threat model spelled out once, and add it to `README.md`'s Contents table
(`README.md:24-37`) the way every other phase's doc got added.

### 9.4 — The share-target landing page

`app/(protected)/resparkable/capture/page.tsx` — a thin page hosting the same
capture affordance as the sidebar widget, sized for a full-page landing rather
than a drawer. Reads `?text=`/`?url=`/`?title=` (the Web Share Target GET
query shape) and pre-fills the textarea, appending the shared URL to the text
the way a manually pasted link would read. This is 9.5's actual prerequisite —
the manifest step below has nothing to point at until this exists.

### 9.5 — PWA scaffolding

Confirmed greenfield (§1d; no `app/manifest.ts` anywhere, `public/` holds only
favicons). `app/manifest.ts`: `start_url: '/resparkable'`, `display:
'standalone'`, 192/512 + one maskable icon, `shortcuts` (Capture, Today, Inbox),
`appleWebApp` metadata for iOS home-screen install (iOS ignores `manifest.json`
share targets entirely — this is an Android-only mechanism, so the win here is
narrower than "share sheet on every phone" and worth stating as such rather than
oversold). `share_target`: `method: 'GET'` → `/resparkable/capture` (9.4),
`params: { title, text, url }`. CSP already permits it
(`worker-src 'self' blob:`, `default-src 'self'`, per `plan.md` §8) — no change
needed there.

### 9.6 — Confirm the Shortcut path, change nothing

Per §1c: no code. Point install.md's existing §4.3 at this phase in a one-line
cross-reference (it currently reads `_(phase 7b)_`, which is when it actually
shipped — leave that, but note in `sunrise-asks.md` #34 that this is the row
still blocking the narrower scope, so a future contributor doesn't go looking
for phase-9 Shortcut work that isn't there).

---

## 4. What phase 9 must not quietly become

- **Image capture does not gain a storage surface.** The original photo is
  extracted and discarded, same invariant as voice's "not persisted" audit
  comment. If a later release wants "keep the photo too", that's a deliberate
  product decision with its own retention story — not a side effect of wiring
  up a camera button.
- **The intake agent never becomes chat-addressable.** It exists to be the
  _only_ thing `resparkable_capture_for_token` is bound to; adding it to
  `RESPARKABLE_CHAT_AGENT_SLUGS` would hand a browser the same
  ignores-`context.userId` path the inbound email route uses, which is the
  exact escalation §8's compensating controls exist to prevent.
- **No workaround for the `AiApiKey` scope gap.** The temptation is a
  Resparkable-owned shim — a second header, a custom claim, anything that
  avoids touching `lib/auth/api-keys.ts`. Don't; `install.md` §4.3 already
  ships a working, explicitly-risk-stated answer, and a shim would be a second,
  undocumented one.
- **The share-target win is Android-only, and the docs should say so.** iOS's
  PWA support has no `share_target` equivalent; the Shortcut (§1c/9.6) is the
  iOS two-second-capture answer, the share target is Android's. Writing the PWA
  section as if it covers both phones would be the exact kind of claim
  `capture-channels.md` (9.3) should prevent someone from having to discover by
  testing.

## 5. The operational risk, stated once

**Postmark inbound needs DNS pointed at Postmark and an inbound server
configured there** — the adapter and the route are ready, but nothing in this
repo can make an MX record exist. This is the same shape as phase 7's cron
warning (`phase-7-plan.md` §5): the code being done and the feature working are
two different facts, and the gap between them is an infrastructure step that
belongs in `install.md` as a required host action, not a footnote discovered
when the first test email never arrives.

**Ask #34 / sunrise#542 stays open after this phase.** Nothing in phase 9
resolves it — the Shortcut path works today on a wider-than-ideal scope, and
stays that way until Sunrise lands the extensible-scope seam. Phase 9 should
not be read as having "done" that item; it inherits it.

---

## 6. Verification

- `npm run smoke:transcribe` — already passing (§1a shipped ahead of this plan).
- A new smoke or manual check for the image route: seed a vision-capable
  `AiProviderModel` row the way `smoke:vision.ts` already does, POST a small
  test image, assert extracted text comes back and no row lands in whatever
  table would carry a persisted original.
- `curl` a Postmark-shaped payload at
  `/api/v1/inbound/postmark/resparkable-capture-intake` with the Basic-auth
  header, using a stubbed `inboxToken`/`from` — assert a thought lands with
  `source: 'email'` and a repeat `MessageID` dedupes.
- Chrome DevTools → Application → Manifest: installability checks pass, icons
  present at both sizes, `share_target` validates.
- The end-to-end case from `plan.md` §15: record a thought by voice on a phone,
  and by photographing a handwritten note, and find each by meaning in
  `/resparkable/search` afterward.
- Automated coverage landed alongside the code rather than as a follow-up:
  `capture-for-token.test.ts`, `transcribe-image.route.test.ts`,
  `image-capture-button.test.tsx`, `manifest.test.ts` and the extended
  `quick-capture.test.tsx`/seed test suites exercise every branch in §3 except
  the two genuinely manual items above (a real Postmark delivery, a real
  phone). `npm run framework:resparkable:build-pwa-icons` regenerates the
  icon set from `public/brand/resparkable-icon.svg` — re-run it if that file
  changes.

---

## 7. What landed differently

One correction, found while building §3, bigger than anything else in this
document: **`tool_call` steps do not template-interpolate their `args`.**
`interpolatePrompt` has ten call sites across the executors —
`agent-call.ts`, `chat-turn.ts`, `notification.ts`, `external-call.ts`,
`guard.ts`, `rag-retrieve.ts`, `orchestrator.ts`, `judge-call.ts`,
`llm-runner.ts` — and `executors/tool-call.ts` is not one of them. A
`'{{trigger.mailboxHash}}'`-shaped literal in a `tool_call`'s `config.args`
would reach the capability as that literal string, not the resolved value.
(One shipped template, `tpl-inbound-conversation-handler.ts`, has exactly this
shape in its `send_message_to_channel` step and appears to rely on
interpolation that does not happen — a pre-existing gap this phase's research
surfaced but did not fix, being out of scope for Resparkable's own tier.)

The fix was the one 9.3's own `gather_inputs` precedent (§3, phase 7's
`morningBriefing` workflow) already pointed at: **omit `args` entirely** and
let `tool_call` fall through to `ctx.inputData` — a plain object handed over
by reference, needing no string substitution because nothing in it is a
template. This reshaped two things §3 as drafted did not anticipate:

- **`agentCaptureForTokenSchema` validates the raw inbound-trigger envelope**
  (`{ trigger: <Postmark's normalised payload> }`), not the flat
  `{ inboxToken, from, subject, text, messageId }` shape originally planned.
  The capability extracts the five fields it needs (`parseIntake()` in
  `capture-for-token.ts`) and ignores the rest of Postmark's payload
  (`to`, `cc`, `date`, `htmlBody`, `messageStream`, `attachments`) rather than
  rejecting it.
- **The catalogue's `functionDefinition.parameters` describes the same nested
  shape** — moot for steering a model (this capability is shown to none), but
  kept accurate because `catalogue.test.ts`'s drift check compares it against
  the real schema regardless.

Two smaller items, both already covered inline above rather than deferred:

- `OwnerContact` (`repo/owner-contact.ts`) gained `emailVerified` — needed for
  the sender check and not previously exposed by `findOwnerContact`.
- The generic ownerless-run sweep (`scope.test.ts`) needed one documented
  exception: `resparkable_capture_for_token` is the one capability designed
  to run with no context owner, so it is filtered out of that loop rather
  than asserted against, with a test guarding against the filter silently
  matching nothing if the slug is ever renamed.
