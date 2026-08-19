'use client';

/**
 * BoardsTab — the launcher-opened counterpart to `app/(resparkable)/resparkable/boards/page.tsx`.
 */

import * as React from 'react';
import { z } from 'zod';

import { BoardsList } from '@/components/resparkable/board/boards-list';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { boardSchema, projectSchema, tagSchema } from '@/lib/framework/resparkable/ui/payloads';

const boardsSchema = z.array(boardSchema);
const activeProjectsSchema = z.array(projectSchema);
const tagsSchema = z.array(tagSchema);

export function BoardsTab(): React.ReactElement {
  const [boards, retryBoards] = useTabFetch(`${RESPARKABLE_API.BOARDS}?limit=100`, boardsSchema);
  const [projects] = useTabFetch(
    `${RESPARKABLE_API.PROJECTS}?status=active&limit=200`,
    activeProjectsSchema
  );
  const [tags] = useTabFetch(`${RESPARKABLE_API.TAGS}?limit=100`, tagsSchema);

  if (boards.status === 'loading') return <SkeletonList label="Loading boards" />;
  if (boards.status === 'error') {
    return <TabLoadError what="your boards" message={boards.message} onRetry={retryBoards} />;
  }

  return (
    <BoardsList
      boards={boards.data}
      projects={projects.status === 'ready' ? projects.data : []}
      tags={tags.status === 'ready' ? tags.data : []}
    />
  );
}
