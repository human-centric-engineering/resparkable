// Per-document revision retention cap. Lives in its own file so both the
// server-side prune logic in `revisions.ts` and the client-side
// revision-drawer UI hint can import the same constant without dragging
// the Prisma client into the browser bundle.
export const DEFAULT_REVISION_RETENTION = 50;
