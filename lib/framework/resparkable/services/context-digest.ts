/**
 * The description-summariser's inputs — gathered deterministically, same shape
 * as `services/briefing.ts`: a pure-gather function with zero LLM calls, called
 * by a `tool_call` workflow step, whose output is interpolated straight into the
 * one `agent_call` step that actually writes prose (see
 * `workflows/definitions.ts`'s `contextDigest` workflow).
 *
 * ## Why this doesn't reuse `hydrateLinks`/`findSummaries`
 *
 * Those return an excerpt (`EntitySummary.subtitle`, ~200 chars) — right for a
 * connections list, wrong here: the summariser is meant to read what was
 * actually said, not a fragment of it. This reads `ResparkableThought.content`
 * directly, through `findThoughtsByIds`, and applies its own budget.
 *
 * ## Sensitivity
 *
 * `excludeSensitive: true` on the thought lookup — a `sensitive`-classified
 * capture never reaches the corpus a rewritten description is drafted from.
 * This is the one place in the tier that gate actually changes behaviour today
 * (see `ResparkableThought.sensitivity`'s doc comment).
 */

import * as areas from '@/lib/framework/resparkable/repo/areas';
import * as goals from '@/lib/framework/resparkable/repo/goals';
import { listLinksForEntity } from '@/lib/framework/resparkable/repo/links';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import * as projects from '@/lib/framework/resparkable/repo/projects';
import { findThoughtsByIds } from '@/lib/framework/resparkable/repo/thoughts';

export type ContextDigestEntityType = 'area' | 'goal' | 'project';

export interface ContextDigestNote {
  id: string;
  content: string;
  capturedAt: string;
}

export interface ContextDigest {
  entityType: ContextDigestEntityType;
  entityId: string;
  entityName: string;
  currentDescription: string | null;
  /** Newest first — same ordering `listLinksForEntity` already returns. */
  notes: ContextDigestNote[];
  /** The `ResparkableThought` ids behind `notes`, for the review's `payload`. */
  sourceThoughtIds: string[];
  /** The `ResparkableLink` ids that connected each note, for the same reason. */
  sourceLinkIds: string[];
}

/** Total content budget across every note. Keeps a heavily-linked item's digest bounded. */
const NOTES_CHAR_BUDGET = 6000;
/** Per-note cap, applied first — see `context/contributor.ts`'s `MAX_LINE_CHARS` for the same reasoning: one long note should not crowd out the rest. */
const MAX_NOTE_CHARS = 600;
/** However many notes fit the budget, this is also a hard ceiling — a lightly-linked item still gets a fast digest. */
const MAX_NOTES = 30;

async function findEntity(
  scope: OwnerScope,
  entityType: ContextDigestEntityType,
  entityId: string
): Promise<{ name: string; description: string | null } | null> {
  switch (entityType) {
    case 'area': {
      const area = await areas.findArea(scope, entityId);
      return area ? { name: area.name, description: area.description } : null;
    }
    case 'goal': {
      const goal = await goals.findGoal(scope, entityId);
      return goal ? { name: goal.title, description: goal.description } : null;
    }
    case 'project': {
      const project = await projects.findProject(scope, entityId);
      return project ? { name: project.name, description: project.description } : null;
    }
  }
}

/**
 * Gather everything the summariser needs for one entity.
 *
 * Returns `null` when the entity doesn't exist or isn't the caller's — the same
 * "not found or not yours, indistinguishably" rule `services/links.ts` and
 * `services/neighbours.ts` already follow, so the capability that calls this can
 * answer with one message for both.
 */
export async function buildContextDigest(
  scope: OwnerScope,
  entityType: ContextDigestEntityType,
  entityId: string
): Promise<ContextDigest | null> {
  const entity = await findEntity(scope, entityType, entityId);
  if (!entity) return null;

  const links = await listLinksForEntity(scope, entityType, entityId, {
    statuses: ['accepted'],
  });

  // Only the thought-carrying half of this entity's links — a project-to-goal
  // link has nothing for the summariser to read.
  const thoughtLinks = links
    .map((link) => {
      if (link.sourceType === 'thought') return { linkId: link.id, thoughtId: link.sourceId };
      if (link.targetType === 'thought') return { linkId: link.id, thoughtId: link.targetId };
      return null;
    })
    .filter((row) => row !== null);

  const thoughtIds = thoughtLinks.map((row) => row.thoughtId);
  const thoughts = await findThoughtsByIds(scope, thoughtIds, { excludeSensitive: true });
  const byId = new Map(thoughts.map((thought) => [thought.id, thought]));

  const notes: ContextDigestNote[] = [];
  const sourceThoughtIds: string[] = [];
  const sourceLinkIds: string[] = [];
  let budget = NOTES_CHAR_BUDGET;

  for (const { linkId, thoughtId } of thoughtLinks) {
    if (notes.length >= MAX_NOTES || budget <= 0) break;
    const thought = byId.get(thoughtId);
    // Filtered by sensitivity, already archived, or a dangling link — same
    // "skip, don't error" posture as `link-hydration.ts`'s dangling endpoints.
    if (!thought) continue;

    const content =
      thought.content.length <= MAX_NOTE_CHARS
        ? thought.content
        : `${thought.content.slice(0, MAX_NOTE_CHARS - 1)}…`;
    // Skip, don't stop — links aren't ordered by note size, so one long note
    // ahead of several short ones must not cut the gather short for all of
    // them.
    if (content.length > budget) continue;

    notes.push({ id: thought.id, content, capturedAt: thought.createdAt.toISOString() });
    sourceThoughtIds.push(thought.id);
    sourceLinkIds.push(linkId);
    budget -= content.length;
  }

  return {
    entityType,
    entityId,
    entityName: entity.name,
    currentDescription: entity.description,
    notes,
    sourceThoughtIds,
    sourceLinkIds,
  };
}
