import type { MetadataRoute } from 'next';

import { RESPARKABLE_MANIFEST } from '@/lib/framework/resparkable/pwa/manifest';

/**
 * One-line seam, not an edit — this file did not exist before Resparkable
 * added it. The content lives in `lib/framework/resparkable/pwa/manifest.ts`;
 * see that file's header for why. A host that wants its own PWA identity (a
 * different name, its own icon set) edits this file, not Resparkable's.
 */
export default function manifest(): MetadataRoute.Manifest {
  return RESPARKABLE_MANIFEST;
}
