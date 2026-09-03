/**
 * Wire shapes for the read endpoints the UI consumes.
 *
 * ## Why these exist when the services already export types
 *
 * `TodayPayload` and friends describe what the *service* returns — with real
 * `Date` objects. What a page receives is that object after `JSON.stringify`,
 * where every date is an ISO string and `undefined` has vanished. A server
 * component typed as `TodayPayload` and handed the parsed JSON would be lying,
 * and the lie surfaces as `dueAt.getTime is not a function` at runtime rather
 * than as a type error.
 *
 * So: one schema per payload, describing the wire, and `CLAUDE.md`'s rule about
 * never casting external data is satisfied by construction — a fetch response is
 * external data even when we wrote the endpoint.
 *
 * ## Loose where looseness is correct
 *
 * These are **not** `.strict()`. A response that grows a field must not blank a
 * page on the deploy where the API is ahead of the client — during a rolling
 * deploy that is a normal state, not an error. Unknown keys are dropped; known
 * ones are checked.
 *
 * Dates stay strings. Formatting happens in `<ClientDate>`, which defers to the
 * browser's locale after hydration; parsing them into `Date` here would only
 * invite a server-vs-client locale mismatch back in.
 */

import { z } from 'zod';

/** An ISO timestamp as it arrives over the wire. */
const isoDate = z.string();

/** `priorityFactors` is a `Json?` column — its own schema validates the contents. */
const jsonValue = z.unknown();

// ─── /resparkable/today ──────────────────────────────────────────────────────────

export const todayTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  dueAt: isoDate.nullable(),
  estimateMinutes: z.number().nullable(),
  energy: z.string().nullable(),
  priorityScore: z.number(),
  priorityFactors: jsonValue,
  manualBoost: z.number(),
  manualBoostExpiresAt: isoDate.nullable(),
  snoozeCount: z.number(),
  project: z
    .object({ id: z.string(), name: z.string(), slug: z.string(), status: z.string() })
    .nullable(),
  area: z.object({ id: z.string(), name: z.string(), colour: z.string().nullable() }).nullable(),
});

export type TodayTaskWire = z.infer<typeof todayTaskSchema>;

export const timeBlockSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  taskId: z.string().nullable(),
  projectId: z.string().nullable(),
  areaId: z.string().nullable(),
  startAt: isoDate,
  endAt: isoDate,
  source: z.string(),
  notes: z.string().nullable(),
});

export type TimeBlockWire = z.infer<typeof timeBlockSchema>;

export const linkSchema = z.object({
  id: z.string(),
  sourceType: z.string(),
  sourceId: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  kind: z.string(),
  strength: z.number().nullable(),
  rationale: z.string().nullable(),
  origin: z.string(),
  status: z.string(),
  snoozedUntil: isoDate.nullable(),
  reviewedAt: isoDate.nullable(),
});

export type LinkWire = z.infer<typeof linkSchema>;

/**
 * `GET /resparkable/counts` — the three "waiting on a decision" numbers.
 *
 * Lived inline in the old `(protected)/resparkable/layout.tsx` while the nav
 * rail was the only consumer. The rail is gone; the `Launcher`'s Inbox tile
 * is the consumer now (see that component for why only `inbox` is shown), and
 * a schema two components share belongs here with the rest of them.
 */
export const countsSchema = z.object({
  inbox: z.number(),
  connections: z.number(),
  openTasks: z.number(),
});

export type CountsWire = z.infer<typeof countsSchema>;

export const todayPayloadSchema = z.object({
  generatedAt: isoDate,
  timezone: z.string(),
  tasks: z.array(todayTaskSchema),
  returnedFromSnooze: z.array(z.string()),
  timeBlocks: z.array(timeBlockSchema),
  inboxCount: z.number(),
  openTaskCount: z.number(),
  goalsAtRisk: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      horizon: z.string(),
      targetDate: isoDate.nullable(),
      status: z.string(),
    })
  ),
  unreviewedLinks: z.object({ count: z.number(), items: z.array(linkSchema) }),
  latestReview: z
    .object({
      id: z.string(),
      horizon: z.string(),
      title: z.string().nullable(),
      generatedAt: isoDate,
    })
    .nullable(),
  /**
   * The stored morning briefing. `review` is null before the first overnight
   * run; `stale` is true whenever it cannot be presented as today's.
   */
  briefing: z.object({
    // `title` and `body` are NOT nullable: both columns are non-null on
    // `ResparkableReview`, so a nullable wire type would describe a state the
    // database cannot produce and invite null-handling nobody can ever exercise.
    // The nullability that is real lives one level up — `review` itself is null
    // until the first overnight run.
    review: z
      .object({
        id: z.string(),
        title: z.string(),
        body: z.string(),
        generatedAt: isoDate,
      })
      .nullable(),
    stale: z.boolean(),
    ageHours: z.number().nullable(),
  }),
});

export type TodayPayloadWire = z.infer<typeof todayPayloadSchema>;

// ─── /resparkable/inbox ──────────────────────────────────────────────────────────

export const thoughtSchema = z.object({
  id: z.string(),
  content: z.string(),
  source: z.string(),
  status: z.string(),
  promotedToType: z.string().nullable(),
  promotedToId: z.string().nullable(),
  snoozedUntil: isoDate.nullable(),
  snoozeCount: z.number(),
  archivedAt: isoDate.nullable(),
  /** `manual | aged_out | project_closed` — why it left (§11, phase 8). */
  archivedReason: z.string().nullable().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type ThoughtWire = z.infer<typeof thoughtSchema>;

export const inboxPayloadSchema = z.object({
  generatedAt: isoDate,
  total: z.number(),
  items: z.array(
    z.object({
      thought: thoughtSchema,
      suggestedLinks: z.array(
        z.object({
          id: z.string(),
          targetType: z.string(),
          targetId: z.string(),
          kind: z.string(),
          strength: z.number().nullable(),
          rationale: z.string().nullable(),
          targetLabel: z.string().nullable(),
        })
      ),
      suggestedProjectId: z.string().nullable(),
    })
  ),
});

export type InboxPayloadWire = z.infer<typeof inboxPayloadSchema>;
export type InboxItemWire = InboxPayloadWire['items'][number];

// ─── /resparkable/search ─────────────────────────────────────────────────────────

export const searchHitSchema = z.object({
  id: z.string(),
  entityType: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  archivedAt: isoDate.nullable(),
  /** `manual | aged_out | project_closed` — why it left (§11, phase 8). */
  archivedReason: z.string().nullable().optional(),
  updatedAt: isoDate,
  score: z.number(),
  matchedBy: z.string(),
  snippet: z.string().nullable(),
});

export type SearchHitWire = z.infer<typeof searchHitSchema>;

/** Search returns its hits as the array payload, with `count` in `meta`. */
export const searchHitsSchema = z.array(searchHitSchema);

// ─── Collection rows ─────────────────────────────────────────────────────────

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  areaId: z.string().nullable(),
  priorityScore: z.number(),
  lastActivityAt: isoDate.nullable(),
  closedAt: isoDate.nullable(),
  snoozedUntil: isoDate.nullable(),
  archivedAt: isoDate.nullable(),
  /** `manual | aged_out | project_closed` — why it left (§11, phase 8). */
  archivedReason: z.string().nullable().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type ProjectWire = z.infer<typeof projectSchema>;

export const goalSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  horizon: z.string(),
  parentGoalId: z.string().nullable(),
  areaId: z.string().nullable(),
  targetDate: isoDate.nullable(),
  status: z.string(),
  lastActivityAt: isoDate.nullable(),
  archivedAt: isoDate.nullable(),
  /** `manual | aged_out | project_closed` — why it left (§11, phase 8). */
  archivedReason: z.string().nullable().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type GoalWire = z.infer<typeof goalSchema>;

export const areaSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  colour: z.string().nullable(),
  sortOrder: z.number(),
  archivedAt: isoDate.nullable(),
  /** `manual | aged_out | project_closed` — why it left (§11, phase 8). */
  archivedReason: z.string().nullable().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type AreaWire = z.infer<typeof areaSchema>;

export const entitySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  kind: z.string(),
  description: z.string().nullable(),
  website: z.string().nullable(),
  status: z.string(),
  lastActivityAt: isoDate.nullable(),
  snoozedUntil: isoDate.nullable(),
  archivedAt: isoDate.nullable(),
  /** `manual | aged_out | project_closed` — why it left (§11, phase 8). */
  archivedReason: z.string().nullable().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type EntityWire = z.infer<typeof entitySchema>;

/**
 * A document as the list endpoint returns it — `extractedText` and `storageKey`
 * are stripped there, and `hasOriginal` is added in their place because whether a
 * download exists is useful while the key itself is internal.
 */
export const documentSchema = z.object({
  id: z.string(),
  title: z.string(),
  fileName: z.string(),
  fileHash: z.string(),
  mimeType: z.string(),
  byteSize: z.number(),
  status: z.string(),
  chunkCount: z.number(),
  sourceUrl: z.string().nullable(),
  errorMessage: z.string().nullable(),
  archivedAt: isoDate.nullable(),
  /** `manual | aged_out | project_closed` — why it left (§11, phase 8). */
  archivedReason: z.string().nullable().optional(),
  hasOriginal: z.boolean(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type DocumentWire = z.infer<typeof documentSchema>;

export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  projectId: z.string().nullable(),
  status: z.string(),
  dueAt: isoDate.nullable(),
  deferUntil: isoDate.nullable(),
  estimateMinutes: z.number().nullable(),
  energy: z.string().nullable(),
  contextTag: z.string().nullable(),
  priorityScore: z.number(),
  priorityFactors: jsonValue,
  manualBoost: z.number(),
  manualBoostExpiresAt: isoDate.nullable(),
  manualBoostReason: z.string().nullable(),
  snoozeCount: z.number(),
  completedAt: isoDate.nullable(),
  archivedAt: isoDate.nullable(),
  /** `manual | aged_out | project_closed` — why it left (§11, phase 8). */
  archivedReason: z.string().nullable().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type TaskWire = z.infer<typeof taskSchema>;

// ─── Detail views (`/view` endpoints) ────────────────────────────────────────

/**
 * One end of a connection, resolved.
 *
 * `title: null` means the row the link points at no longer exists — a normal state
 * for a polymorphic edge table with no foreign keys (D2), rendered inertly rather
 * than hidden. `archivedAt` set with a title present is a different fact: the item
 * is still there, just archived.
 */
export const linkEndpointSchema = z.object({
  type: z.string(),
  id: z.string(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  archivedAt: isoDate.nullable(),
  /** `manual | aged_out | project_closed` — why it left (§11, phase 8). */
  archivedReason: z.string().nullable().optional(),
});

/** A connection reduced to the end the viewing page is not. */
export const relatedItemSchema = z.object({
  linkId: z.string(),
  kind: z.string(),
  status: z.string(),
  origin: z.string(),
  strength: z.number().nullable(),
  rationale: z.string().nullable(),
  direction: z.enum(['outgoing', 'incoming']),
  endpoint: linkEndpointSchema,
});

export type RelatedItemWire = z.infer<typeof relatedItemSchema>;

export const projectViewSchema = z.object({
  project: projectSchema,
  area: areaSchema.nullable(),
  tasks: z.array(taskSchema),
  openTaskCount: z.number(),
  totalTaskCount: z.number(),
  related: z.array(relatedItemSchema),
});

export type ProjectViewWire = z.infer<typeof projectViewSchema>;

export const entityViewSchema = z.object({
  entity: entitySchema,
  related: z.array(relatedItemSchema),
});

export type EntityViewWire = z.infer<typeof entityViewSchema>;

export const taskViewSchema = z.object({
  task: taskSchema,
  project: projectSchema.nullable(),
  area: areaSchema.nullable(),
  goalTitle: z.string().nullable(),
  related: z.array(relatedItemSchema),
});

export type TaskViewWire = z.infer<typeof taskViewSchema>;

// ─── /resparkable/connections ────────────────────────────────────────────────────

export const connectionRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  origin: z.string(),
  strength: z.number().nullable(),
  rationale: z.string().nullable(),
  createdAt: isoDate,
  reviewedAt: isoDate.nullable(),
  source: linkEndpointSchema,
  target: linkEndpointSchema,
});

export type ConnectionRowWire = z.infer<typeof connectionRowSchema>;

export const connectionRowsSchema = z.array(connectionRowSchema);

// ─── /resparkable/graph ──────────────────────────────────────────────────────────

export const graphPayloadSchema = z.object({
  focus: z.object({ type: z.string(), id: z.string() }),
  nodes: z.array(
    z.object({
      type: z.string(),
      id: z.string(),
      title: z.string(),
      subtitle: z.string().nullable(),
      depth: z.number(),
    })
  ),
  edges: z.array(
    z.object({
      linkId: z.string(),
      sourceType: z.string(),
      sourceId: z.string(),
      targetType: z.string(),
      targetId: z.string(),
      kind: z.string(),
      status: z.string(),
      strength: z.number().nullable(),
      rationale: z.string().nullable(),
    })
  ),
  /** True when the walk hit the node cap rather than running out of links. */
  truncated: z.boolean(),
  nodeCap: z.number(),
  depth: z.number(),
});

export type GraphPayloadWire = z.infer<typeof graphPayloadSchema>;
export type GraphNodeWire = GraphPayloadWire['nodes'][number];
export type GraphEdgeWire = GraphPayloadWire['edges'][number];

// ─── /resparkable/boards/[id]/view ───────────────────────────────────────────────

export const boardSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  columns: jsonValue,
  membership: z.string(),
  filter: jsonValue,
  swimlaneBy: z.string().nullable(),
  archivedAt: isoDate.nullable(),
  /** `manual | aged_out | project_closed` — why it left (§11, phase 8). */
  archivedReason: z.string().nullable().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type BoardWire = z.infer<typeof boardSchema>;

export const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  colour: z.string(),
  sortOrder: z.number(),
});

export type TagWire = z.infer<typeof tagSchema>;

export const checklistItemSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  text: z.string(),
  isDone: z.boolean(),
  position: z.number(),
  completedAt: isoDate.nullable(),
});

export type ChecklistItemWire = z.infer<typeof checklistItemSchema>;

export const boardCardSchema = z.object({
  task: taskSchema,
  tags: z.array(tagSchema),
  checklist: z.object({
    done: z.number(),
    total: z.number(),
    items: z.array(checklistItemSchema),
  }),
  /** Milliseconds since the card was last touched at all. Always present. */
  untouchedForMs: z.number(),
  /**
   * Milliseconds since the card last changed status — the stronger aging signal.
   *
   * `null` when there is no status-change event to read, which the card renders as
   * the weaker "untouched" wording rather than as a confident wrong number.
   */
  inColumnSinceMs: z.number().nullable(),
  position: z.number().nullable(),
  cardId: z.string().nullable(),
});

export type BoardCardWire = z.infer<typeof boardCardSchema>;

export const boardColumnSchema = z.object({
  status: z.string(),
  label: z.string(),
  wipLimit: z.number().nullable(),
  /** Advisory: the column is over its limit. Never enforced. */
  overWip: z.boolean(),
  cards: z.array(boardCardSchema),
});

export type BoardColumnWire = z.infer<typeof boardColumnSchema>;

export const boardViewSchema = z.object({
  board: boardSchema,
  columns: z.array(boardColumnSchema),
  /** Cards whose status matches no column — surfaced rather than lost. */
  unplaced: z.array(boardCardSchema),
  totalCards: z.number(),
  /**
   * The membership rule in plain English, for a filter board only. `null` on an
   * explicit board, whose contents are exactly the cards the owner put on it.
   *
   * The share dialog is what needs it: §13 requires that sharing a filter board
   * states the rule before the owner agrees to it, because the share keeps
   * handing out tasks created afterwards.
   *
   * `.optional()` for the reason `archivedReason` is: it was added after the
   * shape shipped, and during a rolling deploy a new client will be served by
   * an old server that does not send it. A required field would turn that
   * window into a board tab that fails to parse rather than one that shows no
   * warning. The share dialog treats absent and `null` the same way.
   */
  filterSummary: z.string().nullable().optional(),
});

export type BoardViewWire = z.infer<typeof boardViewSchema>;

// ─── Lifecycle (phase 8) ─────────────────────────────────────────────────────

export const staleSectionSchema = z.object({
  /** `project | goal | area | entity` — which question this section asks. */
  type: z.string(),
  windowDays: z.number(),
  rows: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      lastSignalAt: isoDate.nullable(),
      /**
       * Whole days since the last signal, or `null` when there has never been
       * one. The two render differently on purpose: "quiet for 94 days" and
       * "nothing recorded yet" are different facts, and collapsing the second
       * into "quiet for 0 days" would be a confident wrong number.
       */
      quietDays: z.number().nullable(),
    })
  ),
});

export type StaleSectionWire = z.infer<typeof staleSectionSchema>;

export const staleDigestSchema = z.object({
  generatedAt: isoDate,
  sections: z.array(staleSectionSchema),
  total: z.number(),
});

export type StaleDigestWire = z.infer<typeof staleDigestSchema>;

// ─── Vault import (§14, Release 3) ───────────────────────────────────────────

/**
 * The response from `POST /resparkable/vault/import`, for both a dry run and an apply.
 *
 * `outcome` is `null` on a dry run — which is what makes "would create" and "did
 * create" distinguishable in the UI. Collapsing them into one set of numbers
 * would leave somebody reading a preview as a receipt.
 */
export const vaultImportResponseSchema = z.object({
  applied: z.boolean(),
  summary: z.object({
    creates: z.number(),
    updates: z.number(),
    unchanged: z.number(),
    skipped: z.number(),
    taskUpdates: z.number(),
    mentions: z.number(),
    ignored: z.number(),
  }),
  notes: z.array(
    z.object({
      path: z.string(),
      type: z.string(),
      action: z.enum(['create', 'update', 'unchanged']),
      title: z.string(),
      changedKeys: z.array(z.string()),
      bodyChanged: z.boolean(),
      issues: z.array(z.object({ field: z.string(), message: z.string() })),
      /** An `resparkable-id` that is not one of yours — imported as a new item. */
      unknownId: z.string().nullable(),
    })
  ),
  skipped: z.array(z.object({ path: z.string(), reason: z.string(), detail: z.string() })),
  blankedBodies: z.array(z.string()),
  outcome: z
    .object({
      created: z.number(),
      updated: z.number(),
      tasksTicked: z.number(),
      tasksRetitled: z.number(),
      linksProposed: z.number(),
      failed: z.array(z.object({ path: z.string(), message: z.string() })),
    })
    .nullable(),
});

export type VaultImportResponse = z.infer<typeof vaultImportResponseSchema>;

// ─── Sharing (Release 2, §13) ────────────────────────────────────────────────

/**
 * One item as a shared reader sees it — the allowlisted projection.
 *
 * The same shape the public reader gets, because it is the same projection:
 * `repo/shared-view.ts` is the only place in the tier that uses `select` rather
 * than `omit`, so a column added to `ResparkableTask` next month cannot reach a
 * shared surface by nobody remembering to exclude it.
 *
 * What is deliberately absent is as much the contract as what is here:
 * `priorityScore`, `manualBoostReason`, every foreign key, the item's parent,
 * its links, and its event history.
 */
export const sharedItemSchema = z.object({
  entityType: z.string(),
  id: z.string(),
  title: z.string(),
  /** Markdown, rendered with no raw HTML. Null when the item has no prose. */
  body: z.string().nullable(),
  status: z.string().nullable(),
  dueAt: isoDate.nullable(),
  horizon: z.string().nullable(),
  archived: z.boolean(),
  updatedAt: isoDate,
  tags: z.array(z.string()),
  checklist: z.object({ done: z.number(), total: z.number() }).nullable(),
});

export type SharedItemWire = z.infer<typeof sharedItemSchema>;

/**
 * Who shared something with me.
 *
 * Present at all only because the basis is a **grant**. A public link never
 * carries this: a stranger holding a URL gets the content and learns nothing
 * about whose it is. That is the line the whole access layer is drawn on.
 */
export const sharedOwnerSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
});

export const sharedWithMeItemSchema = z.object({
  item: sharedItemSchema,
  owner: sharedOwnerSchema,
  role: z.string(),
  canComment: z.boolean(),
  includeTaskDetail: z.boolean(),
  sharedAt: isoDate,
  expiresAt: isoDate.nullable(),
});

export type SharedWithMeItemWire = z.infer<typeof sharedWithMeItemSchema>;

export const sharedWithMeListSchema = z.array(sharedWithMeItemSchema);

/** One shared item opened: the item, its cascade, and how access was reached. */
export const sharedItemDetailSchema = z.object({
  item: sharedItemSchema,
  children: z.array(sharedItemSchema),
  /** True when the cascade was capped, so the page can say so rather than lie. */
  childrenTruncated: z.boolean(),
  includeTaskDetail: z.boolean(),
  owner: sharedOwnerSchema,
  basis: z.string().nullable(),
  canComment: z.boolean(),
  /**
   * The granted parent, when this item was reached through a cascade. Lets the
   * page say "shared as part of Acme Redesign" instead of implying the child
   * was handed over on its own.
   */
  via: z.object({ entityType: z.string(), entityId: z.string() }).nullable(),
});

export type SharedItemDetailWire = z.infer<typeof sharedItemDetailSchema>;

export const sharedSearchHitSchema = z.object({
  item: sharedItemSchema,
  owner: sharedOwnerSchema,
  /** The granted parent this hit was reached through, or null if it is one. */
  via: z.string().nullable(),
});

export const sharedSearchHitsSchema = z.array(sharedSearchHitSchema);

export type SharedSearchHitWire = z.infer<typeof sharedSearchHitSchema>;

/**
 * A named grant, as its **owner** sees it.
 *
 * `granteeEmail` is here because the owner typed it — it is their own record of
 * who they shared with. `granteeUserId` is not, and its absence is load-bearing:
 * §13 requires that issuing a grant tells nobody whether the address has an
 * account, or "share with someone" becomes an existence oracle.
 */
export const grantSchema = z.object({
  id: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  granteeEmail: z.string(),
  role: z.string(),
  includeTaskDetail: z.boolean(),
  /**
   * Whether they have bound an account to this grant. **Not** the same question
   * as whether they can see it — they can, from the moment it is issued.
   */
  accepted: z.boolean(),
  invitedAt: isoDate.nullable(),
  expiresAt: isoDate.nullable(),
  revokedAt: isoDate.nullable(),
  active: z.boolean(),
  createdAt: isoDate,
});

export type GrantWire = z.infer<typeof grantSchema>;

export const grantsSchema = z.array(grantSchema);

/** What `POST /resparkable/grants` answers. The grant, and nothing beside it. */
export const createdGrantSchema = z.object({ grant: grantSchema });

/**
 * What `POST /resparkable/grants/[id]/invite` answers.
 *
 * One boolean, and deliberately only one. It says whether an email left the
 * building — the owner's own question about their own action — and nothing
 * about whether the address has an account, which is the answer §13 keeps out
 * of every response on this surface.
 */
export const inviteSentSchema = z.object({ sent: z.boolean() });

/**
 * A public link, as its owner sees it.
 *
 * `tokenPrefix` and never the token: the plaintext exists once, in the 201 that
 * minted it. A lost link is re-minted, not recovered.
 */
export const shareLinkSchema = z.object({
  id: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  tokenPrefix: z.string(),
  includeChildren: z.boolean(),
  includeTaskDetail: z.boolean(),
  expiresAt: isoDate.nullable(),
  revokedAt: isoDate.nullable(),
  active: z.boolean(),
  viewCount: z.number(),
  lastViewedAt: isoDate.nullable(),
  createdAt: isoDate,
});

export type ShareLinkWire = z.infer<typeof shareLinkSchema>;

export const shareLinksSchema = z.array(shareLinkSchema);

/**
 * One entity the owner has shared, with everything they gave away on it.
 *
 * `title` is nullable because the whole point of the surface is shares whose
 * entity the owner can no longer reach: a replaced review, an archived
 * project, a deleted row whose cascade has not landed yet. A schema that
 * required the title would make the rows this page exists for fail validation,
 * which is the failure mode where the page silently shows nothing.
 */
export const myShareItemSchema = z.object({
  entityType: z.string(),
  entityId: z.string(),
  title: z.string().nullable(),
  archived: z.boolean(),
  grants: z.array(grantSchema),
  links: z.array(shareLinkSchema),
});

export type MyShareItemWire = z.infer<typeof myShareItemSchema>;

export const mySharesSchema = z.array(myShareItemSchema);

/** The mint response. `token` and `path` appear here and in no later read. */
export const mintedShareLinkSchema = z.object({
  link: z.object({
    id: z.string(),
    entityType: z.string(),
    entityId: z.string(),
    tokenPrefix: z.string(),
    includeChildren: z.boolean(),
    includeTaskDetail: z.boolean(),
    expiresAt: isoDate.nullable(),
    createdAt: isoDate,
  }),
  token: z.string(),
  path: z.string(),
});

export type MintedShareLinkWire = z.infer<typeof mintedShareLinkSchema>;

/**
 * What `POST /resparkable/invites/accept` answers.
 *
 * A flat shape with everything optional rather than a discriminated union,
 * because the union's two arms are already discriminated by `accepted` and Zod
 * would need the wire to carry a second tag to model that. The page reads
 * `accepted` first and nothing else matters until it has.
 *
 * `expectedEmail` arrives **masked** (`a***@e***.com`) and there is no unmasked
 * form of this field anywhere: the reader needs to recognise which of their own
 * mailboxes to use, and a stranger holding a forwarded email must not be handed
 * a working address.
 */
export const acceptInviteResponseSchema = z.object({
  accepted: z.boolean(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  /** True when this account was already bound — a re-opened email. */
  alreadyAccepted: z.boolean().optional(),
  reason: z.string().optional(),
  expectedEmail: z.string().optional(),
});

export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;

/**
 * What `POST /groups/invites/accept` answers.
 *
 * Tagged by `joined` for the reason the share equivalent is tagged by
 * `accepted`: the page reads the tag first and nothing else matters until it
 * has. `expectedEmail` arrives **masked** and there is no unmasked form of it
 * anywhere, so a stranger holding a forwarded email learns nothing writable-to.
 *
 * `spaceId` is here because joining a group is the one moment the client learns
 * which space it may now open. It grants nothing on its own: every request
 * re-resolves membership through `services/membership.ts`.
 */
export const acceptGroupInviteResponseSchema = z.object({
  joined: z.boolean(),
  groupId: z.string().optional(),
  groupName: z.string().optional(),
  spaceId: z.string().optional(),
  /** True when the row was already there: a second invitation to somebody in. */
  alreadyMember: z.boolean().optional(),
  reason: z.string().optional(),
  expectedEmail: z.string().optional(),
});

export type AcceptGroupInviteResponse = z.infer<typeof acceptGroupInviteResponseSchema>;

/** One comment on a shared item. Author names only — never addresses. */
export const commentSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: z.object({
    id: z.string(),
    name: z.string().nullable(),
    /** Whether the writer is the person whose item this sits on. */
    isOwner: z.boolean(),
  }),
  /** True for the reader's own comment, so the UI can offer edit and delete. */
  mine: z.boolean(),
  editedAt: isoDate.nullable(),
  createdAt: isoDate,
});

export type CommentWire = z.infer<typeof commentSchema>;

export const commentsSchema = z.array(commentSchema);

// ─── Workspaces (phase 47) ───────────────────────────────────────────────────

/**
 * One row of the header switcher: `GET /resparkable/spaces`.
 *
 * `role` is a bare string rather than an enum, on this schema alone, because a
 * role the client does not recognise must render as a workspace it can still
 * open rather than blanking the switcher. What the role is *allowed* to do is
 * decided server-side by `resolveActiveSpaceScope`, never by this label.
 */
export const openableSpaceSchema = z.object({
  spaceId: z.string(),
  name: z.string(),
  kind: z.enum(['personal', 'group']),
  role: z.string(),
  groupId: z.string().nullable(),
});

export const openableSpacesSchema = z.array(openableSpaceSchema);

export type OpenableSpaceWire = z.infer<typeof openableSpaceSchema>;

// ─── Groups (phase 47) ───────────────────────────────────────────────────────

/**
 * One row of `GET /resparkable/groups`.
 *
 * `joinedAt` is nullable and rendered rather than filtered: null means a
 * request to join still waiting on an admin (§23.11, phase 57), and somebody
 * who asked to join should be able to see that they asked.
 */
export const groupListItemSchema = z.object({
  groupId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  spaceId: z.string(),
  role: z.string(),
  joinedAt: z.string().nullable(),
});

export const groupsListSchema = z.array(groupListItemSchema);

/**
 * `GET /resparkable/groups/[id]`.
 *
 * Members are user ids and roles, and deliberately no email addresses. Every
 * member can see who else is in the group, which §23.4 makes unavoidable and
 * correct; handing out everybody's address is a separate decision nobody made.
 */
export const groupMemberSchema = z.object({
  userId: z.string(),
  role: z.string(),
  joinedAt: z.string().nullable(),
});

export const groupDetailSchema = z.object({
  group: z.object({
    groupId: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    spaceId: z.string(),
    maxMembers: z.number(),
  }),
  yourRole: z.string(),
  members: z.array(groupMemberSchema),
});

/** A pending invitation, from `GET /resparkable/groups/[id]/invites`. */
export const groupInviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
  invitedAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
});

export const groupInvitesSchema = z.array(groupInviteSchema);

export type GroupListItemWire = z.infer<typeof groupListItemSchema>;
export type GroupDetailWire = z.infer<typeof groupDetailSchema>;
export type GroupInviteWire = z.infer<typeof groupInviteSchema>;
