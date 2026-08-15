'use client';

/**
 * ContextChatDrawer — the "Tell me more" entry point.
 *
 * Areas and Goals have no `[id]` detail route today (dialog-only, via
 * `ResourceDialog`), and Projects' detail page has no spare real estate for a
 * second full chat surface. A dialog wrapping `<ResparkableChat>` avoids
 * needing a new route for the first two and stays consistent for the third —
 * one component, three call sites (`areas-view.tsx`, `goals-view.tsx`,
 * `project-detail.tsx`).
 *
 * `entityContext` is threaded straight through to `<ResparkableChat>`, which
 * sends it on every turn — see `resparkable_capture_context` for what happens
 * with it server-side.
 */

import type * as React from 'react';

import { ResparkableChat } from '@/components/resparkable/chat/resparkable-chat';
import { ContextSummaryPanel } from '@/components/resparkable/reviews/context-summary-panel';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RESPARKABLE_AGENT_SLUGS } from '@/lib/framework/resparkable/agents';

const STARTERS = [
  "What's on your mind about this?",
  "What's the real reason this matters to you?",
  "What's making this harder than it should be?",
] as const;

export interface ContextChatDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: 'area' | 'goal' | 'project';
  entityId: string;
  /** The entity's own name, for the dialog title — "Tell me more about Health". */
  entityName: string;
  /** For the summary panel's "current vs proposed" comparison. */
  currentDescription?: string | null;
}

export function ContextChatDrawer({
  open,
  onOpenChange,
  entityType,
  entityId,
  entityName,
  currentDescription = null,
}: ContextChatDrawerProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-h-[48rem] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Tell me more about {entityName}</DialogTitle>
          <DialogDescription>
            A conversation, not a form. Anything you share here is kept as a note linked to this{' '}
            {entityType} — the conversation itself never changes what you typed into its
            description. Accepting a proposed summary below does, and that&rsquo;s always your call.
          </DialogDescription>
        </DialogHeader>
        <ContextSummaryPanel
          entityType={entityType}
          entityId={entityId}
          currentDescription={currentDescription}
        />
        <div className="min-h-0 flex-1">
          <ResparkableChat
            agentSlug={RESPARKABLE_AGENT_SLUGS.context}
            starterPrompts={STARTERS}
            entityContext={{ entityType, entityId }}
            heightClassName="h-full"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
