/**
 * App subject-data export seam (GDPR Art. 15).
 *
 * **Fork-owned scaffold** — Resparkable ships this returning nothing and does NOT
 * change it after release, so your edits here merge cleanly on upgrade (the
 * stable contract is this file's `collectAppSubjectData` export, not its body).
 * Treat it like the other `lib/app/*` seams.
 *
 * Auto-wired: `exportUserData()` (`lib/privacy/export-user.ts`) calls this and
 * folds the result into the `app` section of the export bundle, so both the
 * self-service and admin export endpoints pick it up with no core edit.
 *
 * Declare every app-owned table that holds data about a person. Core covers its
 * own tables via `lib/privacy/export-sources.ts`; it cannot see yours.
 *
 * ```ts
 * export async function collectAppSubjectData({ userId }: AppSubjectQuery): Promise<AppSubjectData> {
 *   const [invoices, bookings] = await Promise.all([
 *     prisma.appInvoice.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
 *     prisma.appBooking.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
 *   ]);
 *   return { invoices, bookings };
 * }
 * ```
 *
 * **Why a plain function and not a registry.** The erasure sibling
 * (`lib/privacy/erasure-hooks.ts`) is a boot-time registry, and this seam
 * deliberately is not. Erasure fails loudly if a hook never registers — the
 * rows are still there afterwards. An export fails *silently*: an unregistered
 * collector yields a bundle that looks complete and is not, and neither the
 * subject nor the operator can tell. A static import cannot be missed.
 *
 * **Keep it complete — and core now checks that you did.** Declare your tables
 * in `initAppSubjectSources()` below. The core guard test
 * (`export-sources.test.ts`) diffs `prisma/schema/*.prisma` against the core
 * manifest so a new core table can't quietly narrow the export, and it holds
 * your tier's schema file to the same rule against your declarations: **every**
 * model in a schema file that is not one of Sunrise's own — `app.prisma`,
 * `framework-*.prisma`, or any other name you choose — must be declared as a
 * source or excluded with a reason, or the suite fails naming it.
 *
 * Full accounting, rather than the user-id heuristic core applies to itself,
 * because core reads its own column vocabulary and cannot read yours: a table
 * keyed `authorId` or `respondentId` is invisible to that scan, and the tables
 * it cannot see are exactly the ones nobody remembers. A lookup or join table
 * holding no personal data is an `excluded` row with a one-line reason — which
 * is the note a DPO wants anyway, and it costs you a line once per table.
 *
 * Full guide: .context/privacy/data-export.md · CUSTOMIZATION.md §4
 */

import { registerAppSubjectSources } from '@/lib/privacy/subject-source-registry';
import { spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { collectResparkableCrossSubjectData } from '@/lib/framework/resparkable/access/subject-export';
import {
  collectResparkableSubjectData,
  RESPARKABLE_SUBJECT_SOURCES,
  RESPARKABLE_EXCLUDED_MODELS,
} from '@/lib/framework/resparkable/repo/subject-export';

/** Identity of the subject being exported. */
export interface AppSubjectQuery {
  /** Id of the data subject. */
  userId: string;
  /** The subject's email — for app tables keyed by address rather than user id. */
  email: string;
}

/**
 * App-owned subject data, keyed by section name. Each section lands under
 * `app.<section>` in the export bundle. Values must be JSON-serialisable.
 */
export type AppSubjectData = Record<string, unknown>;

/**
 * Declare the tier's tables to core's subject-source registry.
 *
 * Derived from `RESPARKABLE_SUBJECT_SOURCES` and `RESPARKABLE_EXCLUDED_MODELS`
 * rather than re-typed, for the same reason `lib/app/capabilities.ts` makes one
 * call instead of pasting a list: the tier owns its manifest, so a later
 * Resparkable release can add a table without every host project editing this
 * file. A hand-copied list here would be a second manifest to keep in step, and
 * the failure mode of the two drifting apart is a bundle that reads complete
 * and is not.
 *
 * `tier: 'framework'` because Resparkable sits between Sunrise and its own leaf
 * forks. That leaves the `'app'` slot free for a host project's own tables.
 *
 * Four models are declared here rather than derived, because they are not in
 * the owner-scoped manifest:
 *
 * - `ResparkableGroupMember` / `ResparkableGroupInvite` are keyed on a person
 *   and an address rather than on a space, so they are answered by
 *   `access/subject-export.ts` and named in `RESPARKABLE_CROSS_SUBJECT_MODELS`.
 * - `ResparkableSettings` / `ResparkableBillingSettings` are deployment
 *   configuration keyed by slug, holding no column that names a person. The
 *   owner-scoped guard never asks about them because it scans for `spaceId`;
 *   core asks about every model in a fork-owned schema file, which is the
 *   stricter and better rule.
 */
export function initAppSubjectSources(): void {
  registerAppSubjectSources({
    tier: 'framework',
    sources: [
      ...Object.entries(RESPARKABLE_SUBJECT_SOURCES).map(([model, source]) => ({
        model,
        section: source.section,
        disposition: 'export' as const,
        description: source.holds,
      })),
      {
        model: 'ResparkableGroupMember',
        section: 'groupMemberships',
        disposition: 'export' as const,
        description:
          'Groups the subject belongs to, the role they hold in each, and when they joined.',
      },
      {
        model: 'ResparkableGroupInvite',
        section: 'groupInvites',
        disposition: 'export' as const,
        description:
          'Invitations to a group addressed to the subject, including ones never accepted.',
      },
    ],
    excluded: [
      ...RESPARKABLE_EXCLUDED_MODELS.map((entry) => ({
        model: entry.model,
        reason: entry.reason,
      })),
      {
        model: 'ResparkableSettings',
        reason:
          'Deployment-wide configuration keyed by slug (feature toggles and defaults for the whole install). It holds no column naming a person, so there is nothing in it that is about the subject.',
      },
      {
        model: 'ResparkableBillingSettings',
        reason:
          'Deployment-wide billing configuration keyed by slug (credit prices and grant sizes). It holds no column naming a person; the subject\u2019s own balance and ledger are exported as the billingAccount and billingLedger sections.',
      },
    ],
  });
}

/**
 * Collect this app's data about one subject.
 *
 * FORK NOTE (Resparkable): returns the whole brain, one section per table,
 * spread at the top level of the bundle's `app` object. Resparkable owns its
 * manifest — a later Resparkable release can add a table without every host
 * project editing this file, which is the same reason
 * `lib/app/capabilities.ts` makes one call rather than pasting a list, and why
 * `initAppSubjectSources()` above derives its declarations from that manifest
 * instead of restating it.
 *
 * Static import on purpose, like the other `lib/app/*` seams here: this runs
 * inside `exportUserData()` on a request a person is waiting on, and this repo
 * IS the Resparkable tier so the path always resolves. A host project adds the same
 * two lines; see `.context/framework/resparkable/install.md`.
 *
 * `spaceScope()` is the tier's greppable trust boundary, and this is a
 * legitimate mint site: `userId` reaches here from `exportUserData()`, which
 * takes it from the session (self-service) or an admin route's validated path
 * param — never from a request body or a model.
 */
export async function collectAppSubjectData(subject: AppSubjectQuery): Promise<AppSubjectData> {
  // Two collectors, because the subject's data lives on two sides of a
  // boundary. `repo/subject-export.ts` answers "what is in this person's
  // brain?" and is owner-scoped by construction; `access/subject-export.ts`
  // answers the two questions that are about them but live on *somebody else's*
  // rows — what has been shared with them, and comments they wrote elsewhere.
  //
  // The second is the one the owner-scoped manifest deferred, in as many words,
  // when `ResparkableGrant` was added: "a read across a boundary this repo
  // layer cannot express by construction (D5)". It is answered in `access/**`
  // because reading across a person is what that layer is named for.
  //
  // `email` is threaded through rather than looked up, because an unaccepted
  // invite is addressed by address alone and dropping those would silently omit
  // the grants most likely to have been forgotten about.
  const [own, crossSubject] = await Promise.all([
    collectResparkableSubjectData(spaceScope(subject.userId)),
    collectResparkableCrossSubjectData({ userId: subject.userId, email: subject.email }),
  ]);

  // Flat, not nested under a `resparkable` key as it was before the 0.11.2
  // merge. Core now validates that every section registered through
  // `registerAppSubjectSources()` is delivered as a top-level key of the
  // bundle's `app` object, and throws `DeclaredAppSourceMissingError` when one
  // is not — so a nested wrapper would make every declaration undeliverable.
  //
  // The nesting existed to stop a host project's own app sections colliding
  // with one the tier adds later. That reason is now core's: the registry
  // rejects a second model claiming a section already taken, naming both, and
  // it does so at declaration time rather than by silently overwriting a key.
  // A wrapper on top of that would buy nothing and cost the per-section leak
  // check in `scripts/smoke/export.ts`, which reads `bundle.app[section]`.
  return { ...own, ...crossSubject };
}
