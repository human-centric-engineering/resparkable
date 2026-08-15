/**
 * POST /api/v1/resparkable/areas/:id/summarize — queue a description rewrite.
 *
 * Never writes `description` itself — it queues the summariser workflow, which
 * proposes one as a `ResparkableReview{horizon:'context_summary'}` row for the
 * person to accept or dismiss. See `createSummarizeHandlers`.
 *
 * Authentication: required.
 */

import { createSummarizeHandlers } from '@/lib/framework/resparkable/api/handlers';

export const { POST } = createSummarizeHandlers('area');
