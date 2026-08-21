/**
 * Shared sizing constants for the workspace shell and its loading skeleton.
 *
 * Lives in its own module (rather than being exported from
 * `workspace-shell.tsx`) so `workspace-shell-skeleton.tsx` can read
 * `SIDE_PANE_DEFAULT_SIZE` without importing `workspace-shell.tsx` itself —
 * `workspace-shell.tsx` imports the skeleton for its `mounted`-gated
 * placeholder, and a skeleton-imports-shell-imports-skeleton cycle hits a
 * `SIDE_PANE_DEFAULT_SIZE` TDZ error the moment either module is entered
 * first.
 */

/**
 * Both side panels' `defaultSize`, and what a re-open always resizes to.
 * `workspace-shell-skeleton.tsx`'s placeholder split uses the same value so
 * it can't drift from the real one — see `workspace-shell.tsx`'s header
 * comment for the collapse/expand behavior this feeds.
 */
export const SIDE_PANE_DEFAULT_SIZE = 22;
