/**
 * The sharing layer's public surface (Release 2, §13).
 *
 * Routes import from here, not from the modules beneath — `store.ts` is the
 * only place in this directory that touches Prisma and nothing outside the
 * directory should be reaching into it.
 *
 * **`repo/**` may not import this, and ESLint enforces it**
 * (`lib/framework/eslint.config.mjs`). Every brain query is an owner query or a
 * shared query; the day the repo layer can reach a resolver is the day that
 * stops being a structure and becomes a habit.
 */

export {
  hashShareToken,
  resolveResparkableAccess,
  resolveResparkableAccessMany,
  resolveResparkableShareLink,
  resolveResparkableShareLinkChild,
  resparkableVisibilityScope,
  shareLinkAccess,
} from '@/lib/framework/resparkable/access/resolve';

export {
  RESPARKABLE_CASCADE,
  RESPARKABLE_CASCADE_PARENTS,
} from '@/lib/framework/resparkable/access/cascade';

export {
  ALL_REDACTIONS,
  DENY,
  RESPARKABLE_SHAREABLE_TYPES,
  isResparkableShareableType,
  refKey,
  type LiveGrant,
  type LiveShareLink,
  type ResparkableAccessBasis,
  type ResparkableAccessResult,
  type ResparkableEntityRef,
  type ResparkableNeed,
  type ResparkableRedaction,
  type ResparkableShareableType,
  type ResparkableViewer,
  type ResparkableVisibilityScope,
} from '@/lib/framework/resparkable/access/types';
