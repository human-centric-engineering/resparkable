import { redirect } from 'next/navigation';

import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

/**
 * Retired — Sparkey's own pane absorbs chat (Phase 8 cutover). Kept as a
 * redirect rather than deleted so the route itself, and every existing
 * link to it, still resolves to something rather than a 404.
 */
export default function ResparkableChatPage() {
  redirect(RESPARKABLE_ROUTES.TODAY);
}
