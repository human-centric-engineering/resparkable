'use client';

/**
 * InboxTab — the launcher-opened counterpart to `app/(protected)/resparkable/inbox/page.tsx`.
 *
 * Two independent fetches, same as the server page's `Promise.all` — a
 * failed projects fetch degrades to `[]` (the create-from-thought picker
 * just has nothing to offer) rather than blocking the inbox itself, which
 * is the load-bearing half.
 */

import * as React from 'react';
import { z } from 'zod';

import { InboxView } from '@/components/resparkable/inbox/inbox-view';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { inboxPayloadSchema, projectSchema } from '@/lib/framework/resparkable/ui/payloads';

const activeProjectsSchema = z.array(projectSchema);

export function InboxTab(): React.ReactElement {
  const [inbox, retryInbox] = useTabFetch(RESPARKABLE_API.INBOX, inboxPayloadSchema);
  const [projects] = useTabFetch(
    `${RESPARKABLE_API.PROJECTS}?status=active&limit=200`,
    activeProjectsSchema
  );

  if (inbox.status === 'loading') return <SkeletonList label="Loading inbox" />;
  if (inbox.status === 'error') {
    return <TabLoadError what="your inbox" message={inbox.message} onRetry={retryInbox} />;
  }

  return (
    <InboxView payload={inbox.data} projects={projects.status === 'ready' ? projects.data : []} />
  );
}
