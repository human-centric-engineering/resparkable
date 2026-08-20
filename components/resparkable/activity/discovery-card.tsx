'use client';

/**
 * DiscoveryCard — one proposed connection, why-evidence collapsed by default.
 *
 * Same source/target-chip-plus-badges shape as `ConnectionsView`'s row (it
 * validates against the same `ConnectionRowWire`), but the rationale sits
 * behind an "See why" accordion rather than always on screen — the Activity
 * pane is a persistent sidebar, not a dedicated review page, so a card
 * stays compact until asked to justify itself. Visual chrome (rounded card,
 * icon-only ghost accept/reject buttons with an `aria-label` carrying the
 * promise) matches `ThoughtCard`'s suggestion rows.
 *
 * Reject writes a tombstone (`status: 'rejected'`), not a delete — the
 * caller's `PATCH /links/:id` is what stops the sweep proposing the same
 * pair again, same as everywhere else this decision is made.
 */

import * as React from 'react';
import { ArrowRight, Check, X } from 'lucide-react';

import { EntityChip } from '@/components/resparkable/ui/entity-chip';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { DiscoveryItem } from '@/components/resparkable/activity/activity-types';

const ORIGIN_LABELS: Record<string, string> = {
  user: 'you',
  llm: 'the agent',
};

export interface DiscoveryCardProps {
  item: DiscoveryItem;
  onDecide: (id: string, status: 'accepted' | 'rejected') => void;
}

export function DiscoveryCard({ item, onDecide }: DiscoveryCardProps): React.ReactElement {
  const { connection } = item;

  return (
    // `bg-background`, not `bg-card` — `ActivityPane`'s own wrapper is
    // `bg-card` (it's chrome, not a page), so this card recesses a rung
    // below it instead of matching it (live feedback).
    <li className="bg-background space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <EntityChip
          type={connection.source.type}
          id={connection.source.id}
          label={connection.source.title}
          compact
        />
        <ArrowRight className="text-muted-foreground h-3 w-3 shrink-0" aria-hidden="true" />
        <EntityChip
          type={connection.target.type}
          id={connection.target.id}
          label={connection.target.title}
          compact
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {connection.strength !== null && (
          <Badge variant="outline" className="text-[11px]">
            {Math.round(connection.strength * 100)}% similar
          </Badge>
        )}
        <Badge variant="secondary" className="text-[11px]">
          {ORIGIN_LABELS[connection.origin] ?? 'the sweep'}
        </Badge>
      </div>

      {connection.rationale && (
        <Accordion type="single" collapsible>
          <AccordionItem value="why" className="border-none">
            <AccordionTrigger className="py-1 text-xs font-normal hover:no-underline">
              See why
            </AccordionTrigger>
            <AccordionContent className="text-muted-foreground text-xs">
              {connection.rationale}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}

      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label="Accept this connection"
          onClick={() => onDecide(connection.id, 'accepted')}
        >
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          // "Not this" rather than "delete" — the rejection is kept as a
          // tombstone so the sweep stops offering it.
          aria-label="Not related — don’t suggest this again"
          onClick={() => onDecide(connection.id, 'rejected')}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}
