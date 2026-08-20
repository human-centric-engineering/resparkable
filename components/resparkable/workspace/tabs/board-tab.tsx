'use client';

/**
 * BoardTab — the launcher-opened counterpart to
 * `app/(resparkable)/resparkable/boards/[slug]/page.tsx`.
 *
 * This is one of the two kinds the build plan calls out for real work
 * (`GraphTab` is the other):
 *
 * - **The slug→id→view sequence is genuinely dependent, not just batched.**
 *   The board list is fetched first; only once it resolves is the board's
 *   `id` known, and only then can the `/view` and tags calls fire. That's
 *   exactly what `useTabFetch`'s `endpoint: null` (don't fetch yet) is
 *   for — the second `useTabFetch` call's endpoint is `null` until
 *   `boards` resolves and a matching slug is found, so the effect simply
 *   doesn't run until then, instead of a manual multi-stage fetch dance.
 * - **The "All boards" link becomes `openTab`, not `<Link>`.** The
 *   server page's `<Link href="/resparkable/boards">` is a real page
 *   navigation, which is meaningless inside a tab — this pane isn't a
 *   route, and other panes may be showing other things. It opens the
 *   Boards list as a tab in the same pane instead.
 */

import * as React from 'react';
import { Download, FileQuestion } from 'lucide-react';
import { z } from 'zod';

import { BoardView } from '@/components/resparkable/board/board-view';
import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { Button } from '@/components/ui/button';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { boardSchema, boardViewSchema, tagSchema } from '@/lib/framework/resparkable/ui/payloads';

const boardsSchema = z.array(boardSchema);
const tagsSchema = z.array(tagSchema);

export interface BoardTabProps {
  slug: string;
}

export function BoardTab({ slug }: BoardTabProps): React.ReactElement {
  const workspace = useWorkspace();
  const [boards, retryBoards] = useTabFetch(`${RESPARKABLE_API.BOARDS}?limit=200`, boardsSchema);

  const boardId =
    boards.status === 'ready'
      ? (boards.data.find((entry) => entry.slug === slug)?.id ?? null)
      : null;

  const [view, retryView] = useTabFetch(
    boardId ? RESPARKABLE_API.viewPath(RESPARKABLE_API.BOARDS, boardId) : null,
    boardViewSchema
  );
  const [tags] = useTabFetch(boardId ? `${RESPARKABLE_API.TAGS}?limit=100` : null, tagsSchema);

  if (boards.status === 'loading') return <SkeletonList label="Loading board" />;
  if (boards.status === 'error') {
    return <TabLoadError what="this board" message={boards.message} onRetry={retryBoards} />;
  }

  // `boards` is ready but no matching slug was found — the server page's
  // `notFound()` moment, scoped to this pane instead of the whole route.
  if (boardId === null) {
    return (
      <EmptyState
        icon={FileQuestion}
        title="Board not found"
        description="It may have been deleted, or the link is out of date."
      />
    );
  }

  if (view.status === 'loading') return <SkeletonList label="Loading board" />;
  if (view.status === 'error') {
    if (view.httpStatus === 404) {
      return (
        <EmptyState
          icon={FileQuestion}
          title="Board not found"
          description="It may have been deleted, or the link is out of date."
        />
      );
    }
    return <TabLoadError what="this board" message={view.message} onRetry={retryView} />;
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{view.data.board.name}</h2>
          <p className="text-muted-foreground text-xs">
            {view.data.totalCards} {view.data.totalCards === 1 ? 'card' : 'cards'} ·{' '}
            {view.data.board.membership === 'explicit'
              ? 'hand-picked, in the order you set'
              : 'a live query, ordered by what matters most'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <a href={RESPARKABLE_API.boardExport(view.data.board.id, 'csv')}>
              <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              CSV
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={RESPARKABLE_API.boardExport(view.data.board.id, 'json')}>
              <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              JSON
            </a>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => workspace.openTab('boards')}>
            All boards
          </Button>
        </div>
      </div>

      <BoardView view={view.data} allTags={tags.status === 'ready' ? tags.data : []} />
    </div>
  );
}
