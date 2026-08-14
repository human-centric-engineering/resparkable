import type { Metadata } from 'next';

import { ResparkableChat } from '@/components/resparkable/chat/resparkable-chat';
import { RESPARKABLE_AGENT_SLUGS } from '@/lib/framework/resparkable/agents';

export const metadata: Metadata = {
  title: 'Talk',
  description: 'A reflective conversation, kept as notes rather than a form.',
};

/**
 * The freeform "tell me more" surface — no Area/Goal/Project anchor.
 *
 * Same component as `/resparkable/chat`, a different agent
 * (`RESPARKABLE_AGENT_SLUGS.context`) and no `entityContext` prop, which is
 * what makes a capture here land unlinked rather than attached to an item —
 * see `resparkable_capture_context`.
 */
const STARTERS = [
  "What's been on your mind lately?",
  'Tell me about someone important to you right now.',
  "What's a constraint you're working around?",
] as const;

export default function ResparkableContextPage() {
  return (
    <div className="space-y-4">
      <ResparkableChat agentSlug={RESPARKABLE_AGENT_SLUGS.context} starterPrompts={STARTERS} />
    </div>
  );
}
