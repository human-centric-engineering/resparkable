import type { Metadata } from 'next';
import { z } from 'zod';

import { AreasView } from '@/components/resparkable/areas/areas-view';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { areaSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readSpaceTarget } from '@/lib/framework/resparkable/ui/active-space';
import {
  readResparkable,
  type ResparkableSearchParams,
} from '@/lib/framework/resparkable/ui/server-read';
import { getSparkeyPronoun } from '@/lib/resparkable/get-sparkey-pronoun';

export const metadata: Metadata = {
  title: 'Life',
  description: "What's important in your life right now, and why.",
};

export default async function ResparkableAreasPage({
  searchParams,
}: {
  searchParams: ResparkableSearchParams;
}) {
  const space = readSpaceTarget(await searchParams);
  const [areas, pronoun] = await Promise.all([
    readResparkable(`${RESPARKABLE_API.AREAS}?limit=200`, z.array(areaSchema), space),
    getSparkeyPronoun(),
  ]);

  if (!areas.ok) {
    return <LoadError what="your life areas" message={areas.message} />;
  }

  return <AreasView areas={areas.data} pronoun={pronoun} />;
}
