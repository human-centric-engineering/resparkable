/**
 * Transfer policy for the brain.
 *
 * The read half of this already exists — `repo/subject-export.ts` answers "what
 * is this person owed?" for GDPR Art. 15. This answers the harder question:
 * what can be written back into a *different* account, and what happens to
 * everything that pointed at something by id.
 *
 * ## Data only, on purpose
 *
 * This file imports no database client and calls nothing. It is a declaration
 * that the generic engine in `lib/portability/**` reads. That keeps it inside
 * the tier's ESLint boundary (only `repo/**` may reach Prisma) without needing
 * an exemption, and it means the whole policy can be unit-tested as a value.
 *
 * ## What is special about this tier
 *
 * Every table hangs off `ResparkableSpace` through `userId`, which is
 * simultaneously the owner column and the foreign key to the space row. So the
 * space must be written first, and every other table's ownership is rewritten by
 * changing one column. That is why the brain is the easy half of a transfer —
 * and why the hard part is everything that refers to a row *without* a foreign
 * key behind it.
 *
 * @see lib/portability/policy.ts — what each field means
 * @see lib/framework/resparkable/repo/subject-export.ts — the Art. 15 half
 * @see .context/framework/resparkable/transfer.md
 */

import { randomBytes } from 'node:crypto';

import { SEARCHABLE_ENTITY_TYPES } from '@/lib/framework/resparkable/validations';
import type { SoftRef, TransferPolicySet } from '@/lib/portability/policy';

/**
 * Maps a stored `entityType` / `sourceType` value onto its Prisma model.
 *
 * Derived from {@link SEARCHABLE_ENTITY_TYPES} rather than written out, so that
 * making a new kind of thing linkable updates the remapping automatically. The
 * `Resparkable` + capitalised-name convention is checked against the real model
 * graph by the coverage guard, which fails if a type is added that does not
 * follow it — the one way this derivation could go quietly wrong.
 */
const BRAIN_TYPE_MAP: Readonly<Record<string, string>> = Object.fromEntries(
  SEARCHABLE_ENTITY_TYPES.map((type) => [
    type,
    `Resparkable${type.charAt(0).toUpperCase()}${type.slice(1)}`,
  ])
);

/** What a thought can be promoted into. */
const PROMOTION_TYPE_MAP: Readonly<Record<string, string>> = {
  task: 'ResparkableTask',
  project: 'ResparkableProject',
  goal: 'ResparkableGoal',
};

/** Collapse whitespace and case so two spellings of one title compare equal. */
function normaliseTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Stringify a value read out of an untyped row.
 *
 * A soft merge key is computed over `Record<string, unknown>` — the row may have
 * come from a bundle rather than from Prisma — so a bare `String()` would
 * happily render an object as `[object Object]` and make two unrelated rows
 * compare equal. Anything that is not already a primitive contributes nothing.
 */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** `YYYY-MM-DD`, or empty — dates arrive as strings from a bundle, as Dates from the DB. */
function dayOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && value.length >= 10) return value.slice(0, 10);
  return '';
}

const BRAIN = { owner: 'framework:resparkable', group: 'brain' } as const;

/**
 * `indexedHash` appears on seven tables and means the same thing on all of them.
 *
 * Written once and spread, rather than restated seven times: an exemption from
 * the secret guard is only worth anything if somebody reads it, and seven
 * copies of the same sentence is how a reader learns to skip them.
 */
const INDEXED_HASH_REVIEWED = {
  indexedHash:
    'A digest of this row’s own text, used to notice when it has changed and ' +
    'needs re-embedding. Derived from content that is itself in the bundle, so ' +
    'it discloses nothing further — and it is reset on import in any case.',
} as const;

/**
 * §23.5's authorship column, as an import sees it.
 *
 * Every satellite gained `createdByUserId` in phase 45, and on a personal brain
 * it is redundant with the owner. It still has to be *classified*, because the
 * column holds a `User` id with no Prisma relation behind it (the FK is
 * hand-written, since Resparkable must not add a relation field to the
 * Sunrise-owned `User`) and an unclassified reference-shaped column is what
 * `policy-coverage.test.ts` refuses to let ship.
 *
 * Remapped rather than dropped, so an imported brain says the importing account
 * wrote its own notes rather than naming a stranger. `null` on unresolved
 * because losing authorship costs nothing here: a personal space has exactly one
 * author and the owner column already records who that is. Contrast
 * `ResparkableSpace.ownerUserId`, which drops the row instead, because there the
 * same value carries the erasure cascade.
 *
 * Group spaces do not transfer with an account at all (§23.6), so the case where
 * this column names somebody OTHER than the space's owner never reaches an
 * import bundle.
 */
const AUTHORED_BY: SoftRef = {
  idColumn: 'createdByUserId',
  model: 'User',
  onUnresolved: 'null',
};

/**
 * The same column on a model that leaves but never comes back.
 *
 * An `export-only` policy is read on the way out and never written on the way
 * in, so there is no id to remap and {@link AUTHORED_BY}'s question does not
 * arise. It still needs an answer on the record, because the coverage guard
 * cannot tell "nobody imports this" from "nobody thought about this", and those
 * two look identical right up until somebody flips a disposition.
 */
const AUTHORED_BY_NOT_IMPORTED =
  'Who wrote the row (§23.5). This model is export-only, so nothing ever ' +
  'writes this column on import and there is no id to remap. On import it ' +
  'would take the same answer as every transferable sibling: remap to the ' +
  'importing account, null if unresolved.';

export const resparkableTransferPolicies: TransferPolicySet = {
  policies: [
    {
      ...BRAIN,
      model: 'ResparkableSpace',
      disposition: 'transfer',
      note: 'The brain itself — your timezone, weekly capacity and how work gets prioritised.',
      ownerColumn: 'userId',
      mergeKeys: [['userId']],
      // A live bearer token: anyone holding it can post into this person's
      // inbox, on the installation this bundle was taken FROM. So it is dropped
      // rather than merely not-written — `repo/subject-export.ts` omits it from
      // the Art. 15 export for exactly this reason, and a transfer bundle is
      // more of "a file that gets emailed, synced and forgotten", not less.
      // Being absent also makes the import unambiguous: the column is unique,
      // so the target has to mint its own regardless.
      redact: ['inboxToken'],
      // Required, unique, and never in a bundle — so an import has to issue one
      // or it cannot write this table at all. Sized and encoded exactly as
      // `services/space.ts` does when it mints one for a new user: 16 bytes of
      // hex, because the value lands in an email local part and has to survive
      // mail systems that lowercase it.
      mint: { inboxToken: () => randomBytes(16).toString('hex') },
      reset: {
        // A similarity threshold tuned against whichever embedding model
        // produced this brain's vectors. Carried into an environment running a
        // different model it does not error — it silently stops proposing
        // connections, or proposes nonsense. Re-learned from scratch instead.
        connectionStrengthFloor: null,
      },
      jsonOpaque: {
        energyProfile: 'Time-of-day energy buckets. Numbers and weekday names.',
        priorityWeights: 'Scoring weights. Numbers.',
        retentionPolicy: 'How long to keep things, in days. Numbers.',
      },
      // Phase 45 (§23.2) gave this table a SECOND column holding a user id, and
      // an import has to rewrite both.
      //
      // `ownerColumn` covers `userId`, the space key, and there is only one of
      // it. `ownerUserId` carries the GDPR cascade, and left alone it would
      // arrive from the bundle still naming the person the bundle came FROM.
      // That is not a cosmetic wrongness: the hand-written FK behind it is
      // ON DELETE CASCADE, so an imported brain would be destroyed when a
      // stranger closed their account, and until then it would be reachable by
      // that stranger's erasure rather than by its actual owner's.
      //
      // A soft reference is the right shape and not a workaround. The column
      // genuinely is an id into `User` with no Prisma relation behind it (the
      // FK is hand-written because Resparkable must not add a relation field to
      // the Sunrise-owned `User`), which is the exact case `softRefs` exists
      // for, and the import's id map already resolves the bundle's user to the
      // importing account.
      //
      // `drop-row` rather than `null`, and the choice is load-bearing. `User`
      // always travels with a bundle, so unresolved means a hand-edited or
      // truncated file; a null owner would leave a whole brain that no erasure
      // can ever reach, which is a permanent Art. 17 hole created by a malformed
      // input. Dropping the space drops everything hanging off it, which sounds
      // drastic and is the point: a bundle that cannot say whose brain this is
      // should not produce one.
      softRefs: [{ idColumn: 'ownerUserId', model: 'User', onUnresolved: 'drop-row' }],
    },

    {
      ...BRAIN,
      model: 'ResparkableArea',
      disposition: 'transfer',
      note: 'The life areas you organise everything else under.',
      ownerColumn: 'userId',
      mergeKeys: [['userId', 'slug']],
      reset: { indexedHash: null },
      secretReviewed: { ...INDEXED_HASH_REVIEWED },
      softRefs: [AUTHORED_BY],
    },

    {
      ...BRAIN,
      model: 'ResparkableGoal',
      disposition: 'transfer',
      note: 'Goals across every horizon, including which goal sits under which.',
      ownerColumn: 'userId',
      // A real constraint, as for areas, projects and entities. This table used
      // to carry a soft key instead — horizon, normalised title, target date —
      // because it had no `@@unique` to point at, and that guess was the one
      // thing blocking `conflictMode: 'overwrite'`: writing into a row matched
      // on a guess is writing into a guess. The soft key is gone rather than
      // kept as a fallback, so there is exactly one answer to "is this the same
      // goal?" and it is the same answer the vault importer gives.
      mergeKeys: [['userId', 'slug']],
      reset: { indexedHash: null },
      secretReviewed: { ...INDEXED_HASH_REVIEWED },
      softRefs: [AUTHORED_BY],
    },

    {
      ...BRAIN,
      model: 'ResparkableProject',
      disposition: 'transfer',
      note: 'Projects, their status, and which area they belong to.',
      ownerColumn: 'userId',
      mergeKeys: [['userId', 'slug']],
      reset: {
        indexedHash: null,
        // Recomputed by the prioritiser on the far side. The stored score is
        // relative to the weights and the population it was computed against,
        // so importing it would rank new work against an old brain's scale.
        priorityScore: 0,
        priorityFactors: null,
      },
      jsonOpaque: {
        priorityFactors:
          'The breakdown behind the score — named factors and their numeric ' +
          'contributions. Reset on import rather than carried, so nothing here ' +
          'survives to need remapping.',
      },
      secretReviewed: { ...INDEXED_HASH_REVIEWED },
      softRefs: [AUTHORED_BY],
    },

    {
      ...BRAIN,
      model: 'ResparkableTask',
      disposition: 'transfer',
      note: 'Tasks with their notes, scheduling, snooze history and manual priority boosts.',
      ownerColumn: 'userId',
      reset: { priorityScore: 0, priorityFactors: null },
      // Deliberately no merge key. Two tasks with the same title are usually two
      // tasks. A duplicate task is a minor annoyance; a wrongly merged one loses
      // notes, scheduling and history that cannot be recovered.
      jsonOpaque: {
        priorityFactors: 'Scoring breakdown. Reset on import, as for projects.',
      },
      secretReviewed: {
        // `manualBoost` is not a secret, but it is the one column an agent is
        // forbidden from writing — it is the user's own override of the
        // prioritiser. It transfers verbatim: it is precisely the thing someone
        // would be angriest to lose, and an expired boost reads as zero anyway.
        manualBoost: 'A user-set priority override, not credential material.',
      },
      softRefs: [AUTHORED_BY],
    },

    {
      ...BRAIN,
      model: 'ResparkableThought',
      disposition: 'transfer',
      note: 'Raw captured thoughts — the most personal free text in the product.',
      ownerColumn: 'userId',
      reset: { indexedHash: null },
      softRefs: [
        {
          idColumn: 'promotedToId',
          typeColumn: 'promotedToType',
          typeMap: PROMOTION_TYPE_MAP,
          // Nullable, and a thought whose promotion target did not come across
          // is still a thought worth keeping.
          onUnresolved: 'null',
        },
        AUTHORED_BY,
      ],
      softRefsIgnored: {
        externalId:
          'The originating system’s id for a captured message — an email ' +
          'Message-ID, a shortcut run id. Used to avoid capturing the same ' +
          'thing twice, and meaningless as a reference to any row here.',
      },
      // `[userId, externalId]` is a real constraint but `externalId` is null for
      // anything captured in the app, and Postgres treats nulls as distinct — so
      // it binds for exactly the inbound-integration rows and no others. That is
      // still worth having: re-importing must not duplicate emailed captures.
      mergeKeys: [['userId', 'externalId']],
      softMergeKey: (row: Readonly<Record<string, unknown>>): string | null => {
        const content = typeof row.content === 'string' ? row.content.trim() : '';
        if (content === '') return null;
        return `${content}|${dayOf(row.createdAt)}`;
      },
      secretReviewed: { ...INDEXED_HASH_REVIEWED },
    },

    {
      ...BRAIN,
      model: 'ResparkableEntity',
      disposition: 'transfer',
      note: 'Notes about other people and companies — your own record of who is who.',
      ownerColumn: 'userId',
      mergeKeys: [['userId', 'slug']],
      reset: { indexedHash: null },
      secretReviewed: { ...INDEXED_HASH_REVIEWED },
      softRefs: [AUTHORED_BY],
    },

    {
      ...BRAIN,
      model: 'ResparkableTag',
      disposition: 'transfer',
      note: 'Your own tag vocabulary, with the colours and order you gave it.',
      ownerColumn: 'userId',
      mergeKeys: [['userId', 'slug']],
      softRefs: [AUTHORED_BY],
    },

    {
      ...BRAIN,
      model: 'ResparkableTaskTag',
      disposition: 'transfer',
      note: 'Which tags are on which tasks.',
      ownerColumn: 'userId',
      // Both columns are foreign keys, so this can only be evaluated after the
      // tasks and tags they name have been remapped.
      mergeKeys: [['taskId', 'tagId']],
      softRefs: [AUTHORED_BY],
    },

    {
      ...BRAIN,
      model: 'ResparkableChecklistItem',
      disposition: 'transfer',
      note: 'Checklist steps inside tasks.',
      ownerColumn: 'userId',
      // No constraint exists, and position plus text is a reasonable identity
      // for a step within an already-matched task.
      softMergeKey: (row: Readonly<Record<string, unknown>>): string | null => {
        const step = typeof row.text === 'string' ? normaliseTitle(row.text) : '';
        if (step === '') return null;
        return `${text(row.taskId)}|${text(row.position)}|${step}`;
      },
      softRefs: [AUTHORED_BY],
    },

    {
      ...BRAIN,
      model: 'ResparkableBoard',
      disposition: 'transfer',
      note: 'Kanban boards, their columns and their filters.',
      ownerColumn: 'userId',
      mergeKeys: [['userId', 'slug']],
      jsonRefs: [
        // A board with `membership: 'filter'` is a live query, not a fixed list.
        // If this id does not resolve, the board renders empty with no error —
        // so the dry run names every affected board rather than counting them.
        {
          column: 'filter',
          path: 'projectId',
          model: 'ResparkableProject',
          onUnresolved: 'null',
        },
      ],
      jsonOpaque: {
        columns:
          'Column definitions — name, the status each maps to, and a colour. ' +
          'Statuses are enum values, not row ids.',
      },
      softRefs: [AUTHORED_BY],
    },

    {
      ...BRAIN,
      model: 'ResparkableBoardCard',
      disposition: 'transfer',
      note: 'Where each task sits on a board — the arrangement, not just the tasks.',
      ownerColumn: 'userId',
      mergeKeys: [['boardId', 'taskId']],
      softRefs: [AUTHORED_BY],
    },

    {
      ...BRAIN,
      model: 'ResparkableTimeBlock',
      disposition: 'transfer',
      note: 'What you planned or recorded working on, and when.',
      ownerColumn: 'userId',
      softMergeKey: (row: Readonly<Record<string, unknown>>): string | null => {
        const start = row.startAt instanceof Date ? row.startAt.toISOString() : text(row.startAt);
        return `${start}|${text(row.title)}`;
      },
      softRefs: [AUTHORED_BY],
    },

    {
      ...BRAIN,
      model: 'ResparkableLink',
      disposition: 'transfer',
      note:
        'Connections between items, including ones you rejected. Rejected links ' +
        'are kept deliberately: they are what stops the weekly sweep proposing ' +
        'the same connection again for ever.',
      ownerColumn: 'userId',
      softRefs: [
        {
          idColumn: 'sourceId',
          typeColumn: 'sourceType',
          typeMap: BRAIN_TYPE_MAP,
          // Both ends are required columns, so there is nothing to null. A link
          // to something that did not come across is not a link.
          onUnresolved: 'drop-row',
        },
        {
          idColumn: 'targetId',
          typeColumn: 'targetType',
          typeMap: BRAIN_TYPE_MAP,
          onUnresolved: 'drop-row',
        },
        AUTHORED_BY,
      ],
      // Contains four remapped values, so it can only be evaluated after both
      // ends have been resolved.
      mergeKeys: [['userId', 'sourceType', 'sourceId', 'targetType', 'targetId', 'kind']],
    },

    {
      ...BRAIN,
      model: 'ResparkableDocument',
      disposition: 'transfer',
      note: 'Documents you uploaded, and the text extracted from them.',
      ownerColumn: 'userId',
      // Content-addressed, which makes this the one table where identity is
      // exact: the same file is the same row, in any account.
      mergeKeys: [['userId', 'fileHash']],
      reset: {
        indexedHash: null,
        // Rewritten by the importer when the original bytes travel with the
        // bundle, and left null when they do not — in which case the extracted
        // text, which is what the product actually uses, still arrives.
        storageKey: null,
      },
      // The file behind the row. Opt-in per export, because originals are the
      // only incompressible part of a bundle; refusable per installation,
      // because holding somebody's uploads is an operator's decision and an
      // import must not be a way around it. The key layout and that setting both
      // live in `transfer/originals.ts` — this file stays loadable without a
      // database.
      originals: { keyColumn: 'storageKey', contentTypeColumn: 'mimeType' },
      secretReviewed: {
        ...INDEXED_HASH_REVIEWED,
        fileHash:
          'A SHA-256 digest of the file contents, used for de-duplication and ' +
          'as this table’s merge key. Not credential material.',
        storageKey:
          'The blob-store path of the uploaded original, of the form ' +
          '`framework-resparkable/<userId>/<fileHash>`. A location, not a ' +
          'credential — and rewritten on import, or nulled when the originals ' +
          'do not travel.',
      },
      softRefs: [AUTHORED_BY],
    },

    {
      ...BRAIN,
      model: 'ResparkableReview',
      disposition: 'transfer',
      note: 'Your generated weekly and monthly reviews, with their full text.',
      ownerColumn: 'userId',
      reset: { indexedHash: null },
      softRefs: [
        {
          idColumn: 'workflowExecutionId',
          model: 'AiWorkflowExecution',
          // Crosses into the orchestration tables, which are export-only — so
          // this will not resolve even when the whole account moves. The review
          // itself is the artefact worth keeping; the run that produced it is a
          // footnote.
          onUnresolved: 'null',
        },
        AUTHORED_BY,
      ],
      jsonRefs: [
        {
          column: 'payload',
          // A whole-value scan rather than a path, and deliberately so: this
          // column is typed `unknown` because each horizon renders a different
          // shape, and it is writable by an agent. Any path declared here would
          // be correct until the next renderer gained a field, then silently
          // stop matching. See the `'**'` note on JsonRef.
          path: '**',
          onUnresolved: 'keep',
        },
      ],
      softMergeKey: (row: Readonly<Record<string, unknown>>): string | null =>
        `${text(row.horizon)}|${dayOf(row.generatedAt)}`,
      secretReviewed: { ...INDEXED_HASH_REVIEWED },
    },

    {
      ...BRAIN,
      model: 'ResparkableEvent',
      disposition: 'export-only',
      note:
        'Your activity log — what you did in the product and when. Included so ' +
        'the record is yours, but not written back: a timeline recreated in a ' +
        'new environment would describe activity that never happened there, ' +
        'sitting beside real entries and indistinguishable from them.',
      ownerColumn: 'userId',
      softRefsIgnored: {
        createdByUserId:
          'Phase 45 (§23.10): on an EVENT row this is the actor rather than the ' +
          'row’s author — the person who did the thing the event describes. ' +
          'Export-only, so nothing writes it on import and there is no id to remap.',
        entityId:
          'Identifies whichever row an entry describes, across every table in ' +
          'the tier. Kept verbatim because the log is never replayed — it is ' +
          'read against the environment that wrote it.',
      },
      jsonOpaque: {
        metadata:
          'What changed, as short strings and counts. Deliberately never an ' +
          'email address (see the schema comment on this table).',
      },
    },

    {
      owner: 'framework:resparkable',
      group: 'account',
      model: 'ResparkableCreditAccount',
      disposition: 'export-only',
      note:
        'Your current credit balance. Included so the record is yours, but not ' +
        'written back: a balance is a live financial fact tied to what this ' +
        'account was actually granted and actually spent, and writing an ' +
        'exported number into a different account would let a self-export/' +
        'import round trip mint credits nobody granted.',
      ownerColumn: 'userId',
      softRefsIgnored: {
        createdByUserId: AUTHORED_BY_NOT_IMPORTED,
      },
    },
    {
      owner: 'framework:resparkable',
      group: 'account',
      model: 'ResparkableCreditLedgerEntry',
      disposition: 'export-only',
      note:
        'Your spend and grant history. Included so the record is yours, but ' +
        'not written back — the same reasoning as the activity log: replaying ' +
        'it into a new account would describe charges and grants that never ' +
        'happened there.',
      ownerColumn: 'userId',
      softRefsIgnored: {
        createdByUserId: AUTHORED_BY_NOT_IMPORTED,
        relatedConversationId:
          'Soft reference to the chat turn this entry billed, kept verbatim ' +
          'because the entry is never replayed — it is read against the ' +
          'installation that wrote it, same as ResparkableEvent.entityId.',
        relatedWorkflowExecutionId:
          'Points into the orchestration tables (AiWorkflowExecution), which ' +
          'are export-only for the same reason a run’s raw trigger payload ' +
          'is. Kept verbatim, not rewritten.',
        relatedCostLogId:
          'Points into AiCostLog (orchestration), export-only for the same ' +
          'reason. Kept verbatim, not rewritten.',
        createdByAdminId:
          'The admin who made an admin_grant entry, kept as an audit trail ' +
          'of the installation that granted it. Not the entry owner — that is ' +
          'userId — so it is never rewritten to the importer’s own id.',
      },
    },

    // Both sharing tables sit in the `brain` group rather than a `sharing` one:
    // `TransferGroup` is a closed core type (`lib/portability/policy.ts`) and a
    // fork must not widen it for a label. `brain` is the closest true member —
    // a grant is a decision about a brain item — and both rows are
    // export-only, so the group only ever affects how the bundle reads.
    {
      ...BRAIN,
      model: 'ResparkableGrant',
      disposition: 'export-only',
      note:
        'Who you have shared items with, on what terms, and when. Included so ' +
        'the record is yours, but never written back: a grant names a person ' +
        'by the email address they use HERE. Replayed into another ' +
        'installation it would be a live grant addressed to someone who may ' +
        'have no account there, or worse, to a different person who happens to ' +
        'hold that address on the far side — an import that silently starts ' +
        'sharing the brain it just moved. Sharing is a decision made in the ' +
        'place it applies, and it is remade there.',
      ownerColumn: 'userId',
      redact: ['inviteTokenHash'],
      softRefsIgnored: {
        createdByUserId: AUTHORED_BY_NOT_IMPORTED,
        entityId:
          'Identifies whichever row the grant covers, across six tables in the ' +
          'tier. Kept verbatim because the grant is never replayed — it is ' +
          'read against the installation that wrote it, same as ' +
          'ResparkableEvent.entityId.',
        granteeUserId:
          'The grantee’s account id in THIS installation, meaningless in ' +
          'another. Kept verbatim rather than rewritten, for the same reason ' +
          'the row is never imported at all.',
      },
    },
    {
      ...BRAIN,
      model: 'ResparkableComment',
      disposition: 'export-only',
      note:
        'Comments left on items you shared, including who wrote each one. ' +
        'Included so the record is yours — third-party text standing in your ' +
        'brain is exactly the thing you are owed sight of — but never written ' +
        'back, for the same reason as the grant above and one more. A comment ' +
        'is addressed to a relationship that does not exist on the far side: ' +
        'importing one would put words in somebody’s mouth on an installation ' +
        'where they have no account, under an author id that means nothing ' +
        'there, on an item nobody has shared with them. Words attributed to a ' +
        'person are the last thing that should be replayed by a machine.',
      ownerColumn: 'userId',
      softRefsIgnored: {
        createdByUserId: AUTHORED_BY_NOT_IMPORTED,
        entityId:
          'Identifies whichever item the comment sits on, across six tables in ' +
          'the tier. Kept verbatim because the row is never replayed — same as ' +
          'ResparkableGrant.entityId.',
        authorUserId:
          'The author’s account id in THIS installation, meaningless in ' +
          'another. Kept verbatim rather than rewritten, for the same reason ' +
          'the row is never imported at all.',
      },
    },
    {
      ...BRAIN,
      model: 'ResparkableShareLink',
      disposition: 'export-only',
      note:
        'The public links you have minted: what each points at, when it ' +
        'expires, whether you revoked it, how often it was opened. Included so ' +
        'the record is yours, but never written back — a link is a URL other ' +
        'people are holding, and it points at the installation that issued it. ' +
        'Importing one would create a live public link on a different ' +
        'deployment that nobody was ever given, whose token exists nowhere.',
      ownerColumn: 'userId',
      // The digest of a live bearer credential. Absent from the bundle for the
      // same reason `inboxToken` is: an export is a file that gets emailed and
      // synced, and the row is never imported, so nothing needs it.
      redact: ['tokenHash'],
      secretReviewed: {
        tokenPrefix:
          'The first few characters of a token, kept so you can tell two of ' +
          'your own links apart in the UI. Far too short to guess the rest of ' +
          'a 192-bit value from, and useless without the digest, which is ' +
          'redacted above.',
      },
      softRefsIgnored: {
        createdByUserId: AUTHORED_BY_NOT_IMPORTED,
        entityId:
          'Identifies whichever row the link points at. Kept verbatim, never ' +
          'replayed — same as the grant above.',
      },
    },
  ],

  excluded: [
    {
      model: 'ResparkableJob',
      owner: 'framework:resparkable',
      reason:
        'The background-work queue: one row per kind saying when this ' +
        'installation should next triage, brief, sweep or reindex this brain, ' +
        'plus its lease, its failure count and whether it has gone quiet. ' +
        'Every field points at this installation’s clock and its workers — a ' +
        '"due at 04:30" carried into another deployment is a due time for a ' +
        'worker that never claimed it. The far side mints its own set the ' +
        'moment the space is created, from the timezone that travels with it, ' +
        'so nothing is lost by leaving these behind. Same reasoning as ' +
        '`lastSweptAt` used to have before the queue replaced it.',
    },
    {
      model: 'ResparkableBillingSettings',
      owner: 'framework:resparkable',
      reason:
        'A single operator-owned row keyed by slug, holding this ' +
        'installation’s billing policy (credits per dollar, service charge, ' +
        'the new-user grant). It describes the installation rather than any ' +
        'person — there is no user id on it — so importing it would overwrite ' +
        'another operator’s pricing with this one’s. Same reasoning as ' +
        'ResparkableSettings below.',
    },
    {
      model: 'ResparkableEmbedding',
      owner: 'framework:resparkable',
      reason:
        'Search vectors and the text chunks they were built from, derived from ' +
        'thoughts, tasks, notes, documents and reviews that all transfer in ' +
        'full. They carry nothing those rows do not, the vector columns cannot ' +
        'be read or written through Prisma, and a vector produced by one ' +
        'embedding model is meaningless to another — so they are rebuilt on the ' +
        'far side rather than moved.',
    },
    {
      model: 'ResparkableSettings',
      owner: 'framework:resparkable',
      reason:
        'A single operator-owned row keyed by slug, holding whether this ' +
        'installation retains uploaded document originals and how large an ' +
        'upload may be. It describes the installation rather than any person — ' +
        'there is no user id on it — so importing it would overwrite another ' +
        'operator’s policy with this one’s.',
    },
  ],

  crossBoundaryEdges: [
    {
      model: 'ResparkableReview',
      column: 'workflowExecutionId',
      reason:
        'Points into the orchestration tables, where executions are export-only ' +
        'because an inbound run stores its raw trigger payload verbatim. The ' +
        'reference is nulled on import and the review is kept.',
    },
  ],
};
