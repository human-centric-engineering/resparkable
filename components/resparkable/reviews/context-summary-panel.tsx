'use client';

/**
 * ContextSummaryPanel — the accept/dismiss surface for a proposed description.
 *
 * ## Never a blind overwrite
 *
 * The summariser workflow (Release 8) never touches `description` — it queues,
 * runs, and writes a `ResparkableReview{horizon:'context_summary'}` proposal.
 * This panel is the only thing that turns a proposal into a saved change, and
 * it does that by **PATCHing the entity through the same route the boring form
 * already uses** (`RESPARKABLE_API.itemPath`) — there is no second write path
 * for `description`, which is the point: the form field stays the one place
 * that value is actually set.
 *
 * ## Why this fetches its own data instead of taking a server prop
 *
 * Areas and Goals are list-and-dialog pages with no per-row server fetch
 * (`areas-view.tsx`, `goals-view.tsx`) — threading a review lookup through
 * every row on every page load would be exactly the N+1 CLAUDE.md forbids for
 * something that is relevant to at most one row at a time. This panel is
 * opened on demand (from `ContextChatDrawer`'s "Tell me more", or wherever a
 * caller mounts it), so one client-side fetch scoped to the one entity being
 * looked at costs nothing extra.
 *
 * ## Why the workflow's result isn't returned synchronously
 *
 * `POST .../summarize` queues an execution and returns immediately (same
 * "queue rather than run" reasoning as `POST /briefing/regenerate`) — the
 * review doesn't exist until the workflow finishes, seconds to a couple of
 * minutes later. There's no push channel to the browser for a workflow
 * execution, so this polls a few times after queuing rather than making the
 * person guess when to reload.
 */

import * as React from 'react';
import { RefreshCw } from 'lucide-react';
import { z } from 'zod';

import { MarkdownView } from '@/components/resparkable/ui/markdown-view';
import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

const proposalSchema = z.object({
  id: z.string(),
  body: z.string(),
  archivedAt: z.string().nullable(),
  payload: z
    .object({
      entityType: z.string().optional(),
      entityId: z.string().optional(),
    })
    .nullable()
    .optional(),
});

const reviewListSchema = z.array(proposalSchema);

type Proposal = z.infer<typeof proposalSchema>;

export interface ContextSummaryPanelProps {
  entityType: 'area' | 'goal' | 'project';
  entityId: string;
  currentDescription: string | null;
}

const COLLECTION_BY_TYPE: Record<ContextSummaryPanelProps['entityType'], string> = {
  area: RESPARKABLE_API.AREAS,
  goal: RESPARKABLE_API.GOALS,
  project: RESPARKABLE_API.PROJECTS,
};

/** How many times to re-check after queuing, and how far apart. Gives up quietly after — the person can always press the button again. */
const POLL_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ContextSummaryPanel({
  entityType,
  entityId,
  currentDescription,
}: ContextSummaryPanelProps): React.ReactElement | null {
  const [proposal, setProposal] = React.useState<Proposal | null | undefined>(undefined);
  const [polling, setPolling] = React.useState(false);
  const queue = useSaveStatus();
  const decide = useSaveStatus();
  // The dialog this lives in can close mid-poll (`ContextChatDrawer` unmounts
  // its content when closed) — this guards the loop's `setState` calls rather
  // than leaving a `setState` on an unmounted component in flight.
  const mountedRef = React.useRef(true);
  React.useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  const findProposal = React.useCallback(async (): Promise<Proposal | null> => {
    // The API has no per-entity filter on `payload` — this scans the most
    // recent `context_summary` reviews client-side, so the limit needs to be
    // generous enough that an unresolved proposal for an older entity can't
    // fall off the page. 200 is the collection's own max page size.
    const rows = reviewListSchema.parse(
      await apiClient.get<unknown>(RESPARKABLE_API.REVIEWS, {
        params: { horizon: 'context_summary', limit: 200 },
      })
    );
    return (
      rows.find(
        (row) =>
          row.archivedAt === null &&
          row.payload?.entityType === entityType &&
          row.payload?.entityId === entityId
      ) ?? null
    );
  }, [entityType, entityId]);

  React.useEffect(() => {
    let cancelled = false;
    void findProposal().then((found) => {
      if (!cancelled) setProposal(found);
    });
    return () => {
      cancelled = true;
    };
  }, [findProposal]);

  async function requestSummary(): Promise<void> {
    const ok = await queue.run(() =>
      apiClient.post(RESPARKABLE_API.summarizePath(COLLECTION_BY_TYPE[entityType], entityId))
    );
    if (!ok || polling) return;

    setPolling(true);
    try {
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        await sleep(POLL_INTERVAL_MS);
        if (!mountedRef.current) return;
        const found = await findProposal();
        if (!mountedRef.current) return;
        if (found) {
          setProposal(found);
          return;
        }
      }
    } finally {
      if (mountedRef.current) setPolling(false);
    }
  }

  async function accept(): Promise<void> {
    if (!proposal) return;
    const ok = await decide.run(async () => {
      await apiClient.patch(RESPARKABLE_API.itemPath(COLLECTION_BY_TYPE[entityType], entityId), {
        body: { description: proposal.body },
      });
      await apiClient.post(RESPARKABLE_API.dismissReviewPath(proposal.id));
    });
    if (ok) setProposal(null);
  }

  async function dismiss(): Promise<void> {
    if (!proposal) return;
    const ok = await decide.run(() =>
      apiClient.post(RESPARKABLE_API.dismissReviewPath(proposal.id))
    );
    if (ok) setProposal(null);
  }

  // Still loading the initial check — render nothing rather than a flash of
  // the "get a summary" button that then disappears a moment later.
  if (proposal === undefined) return null;

  if (proposal === null) {
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void requestSummary()}
          disabled={queue.state === 'saving' || polling}
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${polling ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          {polling ? 'Writing a summary…' : 'Get a description summary'}
        </Button>
        <SaveStatus state={queue.state} message={queue.message} />
      </div>
    );
  }

  return (
    <div className="bg-muted/40 space-y-3 rounded-md border border-dashed p-3">
      <p className="text-muted-foreground text-xs">
        Proposed from the notes linked to this item. Your own description is unchanged until you
        accept.
      </p>

      {currentDescription && (
        <div className="space-y-1">
          <p className="term-label">Current</p>
          <MarkdownView content={currentDescription} className="text-muted-foreground text-sm" />
        </div>
      )}

      <div className="space-y-1">
        <p className="term-label">Proposed</p>
        <MarkdownView content={proposal.body} className="text-sm" />
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void accept()} disabled={decide.state === 'saving'}>
          Accept
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void dismiss()}
          disabled={decide.state === 'saving'}
        >
          Dismiss
        </Button>
        <SaveStatus state={decide.state} message={decide.message} />
      </div>
    </div>
  );
}
