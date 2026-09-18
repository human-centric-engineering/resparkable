import type { Metadata } from 'next';
import { z } from 'zod';

import { DocumentsView } from '@/components/resparkable/documents/documents-view';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { documentSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readSpaceTarget } from '@/lib/framework/resparkable/ui/active-space';
import {
  readResparkable,
  type ResparkableSearchParams,
} from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Documents',
  description: 'Reference material the brain has read.',
};

export default async function ResparkableDocumentsPage({
  searchParams,
}: {
  searchParams: ResparkableSearchParams;
}) {
  const space = readSpaceTarget(await searchParams);
  const documents = await readResparkable(
    `${RESPARKABLE_API.DOCUMENTS}?limit=100`,
    z.array(documentSchema),
    space
  );

  if (!documents.ok) {
    return <LoadError what="your documents" message={documents.message} />;
  }

  return <DocumentsView documents={documents.data} />;
}
