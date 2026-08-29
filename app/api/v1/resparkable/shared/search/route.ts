/**
 * GET /api/v1/resparkable/shared/search — search what has been shared with me.
 *
 * **A different mechanism from `/resparkable/search`, deliberately.** The
 * owner's search is hybrid: a vector query against `ResparkableEmbedding`
 * blended with BM25. This one never touches that table. The embeddings belong
 * to the **owner** and serve the owner's own recall; a grantee's search reaching
 * into them would put another person's entire corpus behind a text box on the
 * strength of one shared project (§13, §16.5).
 *
 * What it does instead: enumerate the granted refs and their one-level cascade,
 * project them through the same allowlist the public reader uses, and filter the
 * normalised title and body. That makes the guarantee structural — there is no
 * query here that *could* read an embedding — rather than a filter somebody has
 * to keep correct.
 *
 * The cost is honest and worth stating in the UI: this is a substring match, not
 * a semantic one. "deadline" will not find "due Friday".
 *
 * Not rate-limited beyond the section default. `/resparkable/search` has its own
 * 30/min tier because every request there buys an embedding; this one buys
 * nothing but a bounded set of indexed reads.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { searchSharedWithMe } from '@/lib/framework/resparkable/services/shared-with-me';
import { sharedSearchQuerySchema } from '@/lib/framework/resparkable/validations';
import { viewerFromSession } from '@/lib/framework/resparkable/api/viewer';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const query = validateQueryParams(new URL(request.url).searchParams, sharedSearchQuerySchema);

  const result = await searchSharedWithMe(viewerFromSession(session), query);

  // The query text is the user's own and short, but it is still content: what
  // somebody searches for in another person's shared project is not something
  // an operator needs in a log line.
  log.info('Resparkable shared-with-me search', {
    count: result.items.length,
    truncated: result.truncated,
  });

  return successResponse(result.items, {
    count: result.items.length,
    truncated: result.truncated,
  });
});
