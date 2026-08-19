'use client';

/**
 * DocumentsTab — the launcher-opened counterpart to `app/(resparkable)/resparkable/documents/page.tsx`.
 */

import * as React from 'react';
import { z } from 'zod';

import { DocumentsView } from '@/components/resparkable/documents/documents-view';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { documentSchema } from '@/lib/framework/resparkable/ui/payloads';

const documentsSchema = z.array(documentSchema);

export function DocumentsTab(): React.ReactElement {
  const [documents, retry] = useTabFetch(`${RESPARKABLE_API.DOCUMENTS}?limit=100`, documentsSchema);

  if (documents.status === 'loading') return <SkeletonList label="Loading documents" />;
  if (documents.status === 'error') {
    return <TabLoadError what="your documents" message={documents.message} onRetry={retry} />;
  }
  return <DocumentsView documents={documents.data} />;
}
