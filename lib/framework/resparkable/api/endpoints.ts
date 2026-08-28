/**
 * Resparkable's endpoint paths.
 *
 * A tier-owned mirror of `lib/api/endpoints.ts`, which is **Resparkable-owned**:
 * adding Resparkable's routes there would be a merge conflict inflicted on every host
 * project on every upgrade, and the zero-core-file rule exists precisely to stop
 * that (§17 risk 1b). Client components import from here instead.
 *
 * Server code calls services directly and has no use for these; they exist so a
 * `'use client'` component never hard-codes a path string that a later rename
 * would silently break.
 */

export const RESPARKABLE_API = {
  TODAY: '/api/v1/resparkable/today',
  INBOX: '/api/v1/resparkable/inbox',
  SPACE: '/api/v1/resparkable/space',
  /** Badge numbers for the shell — cheap enough to read on every navigation. */
  COUNTS: '/api/v1/resparkable/counts',

  SEARCH: '/api/v1/resparkable/search',
  REINDEX: '/api/v1/resparkable/reindex',

  /** The idempotent front door. Narrower than `THOUGHTS`, and safe to retry. */
  CAPTURE: '/api/v1/resparkable/capture',
  /** The whole brain, small enough for a prompt — what the agent layer reads. */
  SNAPSHOT: '/api/v1/resparkable/snapshot',
  /** Framings on demand. The one endpoint here that makes an LLM call. */
  IDEATE: '/api/v1/resparkable/ideate',

  /**
   * The app-owned chat stream (SSE).
   *
   * Its own route rather than the platform's `/api/v1/chat/stream`, because that
   * one deliberately drops `contextType`/`contextId` — the two fields the whole
   * "always knows my goals" block travels on — and the admin route requires
   * `withAdminAuth`. See `app/api/v1/resparkable/chat/stream/route.ts`.
   */
  CHAT_STREAM: '/api/v1/resparkable/chat/stream',

  /**
   * The stored morning briefing. **Never generates** — the nightly workflow
   * writes it and this serves the row, so the button is instant (§6).
   */
  BRIEFING: '/api/v1/resparkable/briefing',
  /** Queue a fresh briefing. For a failed overnight run, or "surprise me today". */
  BRIEFING_REGENERATE: '/api/v1/resparkable/briefing/regenerate',

  /** Generated artefacts — reviews, briefings, digests. Append-only. */
  REVIEWS: '/api/v1/resparkable/reviews',
  reviewById: (id: string): string => `/api/v1/resparkable/reviews/${id}`,
  /** Dismiss a proposal (e.g. a `context_summary`) so it stops appearing. */
  dismissReviewPath: (id: string): string => `/api/v1/resparkable/reviews/${id}/dismiss`,

  TASKS: '/api/v1/resparkable/tasks',
  PROJECTS: '/api/v1/resparkable/projects',
  GOALS: '/api/v1/resparkable/goals',
  AREAS: '/api/v1/resparkable/areas',
  THOUGHTS: '/api/v1/resparkable/thoughts',
  ENTITIES: '/api/v1/resparkable/entities',
  TIME_BLOCKS: '/api/v1/resparkable/time-blocks',
  BOARDS: '/api/v1/resparkable/boards',
  TAGS: '/api/v1/resparkable/tags',

  /**
   * Item and action paths for the collections above.
   *
   * `collection` is one of the constants on this object, so a caller composes
   * `itemPath(RESPARKABLE_API.TASKS, id)` rather than re-typing the prefix. The three
   * lifecycle actions are named rather than string-built because each has
   * behaviour a raw `PATCH` of the underlying column would skip — the snooze pair
   * increments `snoozeCount` and logs an event, and restore nulls `indexedHash`
   * so the item is re-embedded (see `api/handlers.ts`).
   */
  itemPath: (collection: string, id: string): string => `${collection}/${id}`,
  snoozePath: (collection: string, id: string): string => `${collection}/${id}/snooze`,
  unsnoozePath: (collection: string, id: string): string => `${collection}/${id}/unsnooze`,
  restorePath: (collection: string, id: string): string => `${collection}/${id}/restore`,
  /** Queue the description-summariser workflow for an Area/Goal/Project (Release 8). */
  summarizePath: (collection: string, id: string): string => `${collection}/${id}/summarize`,

  /** Triage: one thought becomes a task, a project or a goal. */
  promotePath: (id: string): string => `/api/v1/resparkable/thoughts/${id}/promote`,

  /** Explicit board membership. Filter-backed boards never use these. */
  boardCards: (boardId: string): string => `/api/v1/resparkable/boards/${boardId}/cards`,
  boardCard: (boardId: string, cardId: string): string =>
    `/api/v1/resparkable/boards/${boardId}/cards/${cardId}`,
  boardExport: (boardId: string, format: 'csv' | 'json'): string =>
    `/api/v1/resparkable/boards/${boardId}/export?format=${format}`,

  /** A task's labels, set as a whole rather than added one at a time. */
  taskTags: (taskId: string): string => `/api/v1/resparkable/tasks/${taskId}/tags`,
  taskChecklist: (taskId: string): string => `/api/v1/resparkable/tasks/${taskId}/checklist`,
  checklistItem: (id: string): string => `/api/v1/resparkable/checklist/${id}`,

  /**
   * The enriched read behind a detail page — one request, fixed query count.
   *
   * A sibling of the item route rather than an `?include=` on it, so the generic
   * item handlers stay bare (see `services/details.ts`).
   */
  viewPath: (collection: string, id: string): string => `${collection}/${id}/view`,

  LINKS: '/api/v1/resparkable/links',
  /** The review queue, with both ends of each link resolved. */
  CONNECTIONS: '/api/v1/resparkable/connections',
  /** A neighbourhood around one node — never the whole corpus. */
  GRAPH: '/api/v1/resparkable/graph',
  linkById: (id: string): string => `/api/v1/resparkable/links/${id}`,
  CONNECTIONS_SWEEP: '/api/v1/resparkable/connections/sweep',

  DOCUMENTS: '/api/v1/resparkable/documents',
  /**
   * Read a file's text and hand it back **without storing it** — the other half
   * of an ad-hoc attachment, where the destination is the capture box rather
   * than the document library. See the route header for why it is not a flag on
   * `DOCUMENTS`.
   */
  DOCUMENTS_EXTRACT: '/api/v1/resparkable/documents/extract',
  documentById: (id: string): string => `/api/v1/resparkable/documents/${id}`,

  /**
   * Speech to text for the capture box. Consumer-side sibling of the platform's
   * admin-only transcribe endpoint; the audio is never persisted.
   */
  TRANSCRIBE: '/api/v1/resparkable/transcribe',
  /** One-shot vision extraction for the capture box's camera button. */
  TRANSCRIBE_IMAGE: '/api/v1/resparkable/transcribe/image',

  /**
   * The whole brain as an Obsidian vault — the one endpoint that returns a file
   * rather than JSON. Takes `?includeArchived=true`.
   */
  VAULT_EXPORT: '/api/v1/resparkable/vault/export',
  /**
   * Read a vault back in. Multipart, and a **dry run unless `apply=true`** — the
   * plan is computed either way, so previewing costs nothing (§14).
   */
  VAULT_IMPORT: '/api/v1/resparkable/vault/import',

  /**
   * What has gone quiet — the four dormancy questions (§11, phase 8).
   *
   * A read that proposes and never acts. The answers go back through the item's
   * own routes (archive, delete) or through `STALE_STILL_LIVE`, which is the one
   * answer nothing else could express.
   */
  STALE: '/api/v1/resparkable/stale',
  STALE_STILL_LIVE: '/api/v1/resparkable/stale/still-live',
  documentDownload: (id: string): string => `/api/v1/resparkable/documents/${id}/download`,

  // ─── Sharing (Release 2, §13) ──────────────────────────────────────────────
  // Two owner surfaces and three grantee ones, and the split is the design:
  // a public link is a document, a named grant is a relationship.

  /**
   * Public share links — the owner's side. `POST` returns the plaintext token
   * **once**; nothing in the system can produce it again, so the UI has to say
   * "copy this now" and mean it.
   */
  /**
   * Freeze a filter board into the cards it currently shows (§13). The share
   * dialog's "share a snapshot instead" button, and the only one of the three
   * dynamic-filter mitigations that is a mechanism rather than a warning.
   */
  boardSnapshot: (id: string): string => `/api/v1/resparkable/boards/${id}/snapshot`,

  SHARE_LINKS: '/api/v1/resparkable/share-links',
  shareLink: (id: string): string => `/api/v1/resparkable/share-links/${id}`,
  /** The reader's own URL, for a copy button. Not an API path. */
  publicShare: (token: string): string => `/s/${token}`,

  /**
   * Named grants — the owner's side. `POST` is an upsert on
   * `(entityType, entityId, granteeEmail)`: sharing again with the same person
   * amends the relationship rather than adding a second one beside it.
   */
  GRANTS: '/api/v1/resparkable/grants',
  grant: (id: string): string => `/api/v1/resparkable/grants/${id}`,
  /**
   * Email the person a grant was issued to.
   *
   * Separate from creating the grant, so a mail outage leaves working access
   * rather than a person told they have access and does not — and so "send it
   * again" is a button rather than a second grant. Capped at 20/day per user:
   * the invite costs this deployment nothing and lands in somebody else's
   * inbox, which is a different kind of limit from every other one in the tier.
   */
  grantInvite: (id: string): string => `/api/v1/resparkable/grants/${id}/invite`,
  /**
   * Bind my account to a share somebody made to my address.
   *
   * Not "grant me access" — the grant is already live for the address it names.
   * The token names the grant and the **session proves the address**, which is
   * what makes a forwarded invite email useless.
   */
  ACCEPT_INVITE: '/api/v1/resparkable/invites/accept',

  /**
   * Comments — the only write path in the tier a non-owner can reach, and the
   * only thing `role: 'commenter'` means.
   *
   * Addressed by `?entityType=&entityId=`, because access is resolved against
   * the item rather than the comment.
   */
  COMMENTS: '/api/v1/resparkable/comments',
  comment: (id: string): string => `/api/v1/resparkable/comments/${id}`,

  /**
   * What other people have shared with me — the grantee's side, and the only
   * read surface in the tier that crosses a person.
   *
   * **There are no write paths under this prefix and there must not be.** A
   * grant is `viewer` or `commenter`; neither implies any authority over the
   * item itself.
   */
  SHARED: '/api/v1/resparkable/shared',
  /**
   * Search across what has been shared with me.
   *
   * A different mechanism from {@link SEARCH}, not a scoped version of it: this
   * one never touches `ResparkableEmbedding`, because that index belongs to the
   * owner. It is a substring match, and the UI should not imply otherwise.
   */
  SHARED_SEARCH: '/api/v1/resparkable/shared/search',
  sharedItem: (entityType: string, entityId: string): string =>
    `/api/v1/resparkable/shared/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,

  /** Admin surface — instance settings, not user data. */
  ADMIN: {
    SETTINGS: '/api/v1/admin/resparkable/settings',
    /** Phase 29: billing. Global policy (credits-per-dollar, service charge, new-user grant). */
    BILLING_SETTINGS: '/api/v1/admin/resparkable/billing/settings',
    /** The per-user balance table. */
    BILLING_ACCOUNTS: '/api/v1/admin/resparkable/billing/accounts',
    /** One-off admin credit grant. */
    BILLING_GRANTS: '/api/v1/admin/resparkable/billing/grants',
  },
} as const;
