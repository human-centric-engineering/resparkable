'use client';

/**
 * AreasView is the Life page: the standing parts of someone's life, and what's
 * on their mind about each one right now.
 *
 * No targets, no capacity, no balancing. Resparkable is a reflection and
 * understanding tool, not an optimisation one: see
 * `.context/framework/resparkable/design-principles.md`. This page's only job
 * is to make it easy to say what matters and why.
 */

import * as React from 'react';
import { Compass, MessageCircle, Pencil, Plus } from 'lucide-react';

import { AreaForm } from '@/components/resparkable/areas/area-form';
import { ContextChatDrawer } from '@/components/resparkable/chat/context-chat-drawer';
import { ArchiveControls } from '@/components/resparkable/ui/archive-controls';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { useSparkeyPronoun } from '@/components/resparkable/sparkey-pronoun-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { AreaWire } from '@/lib/framework/resparkable/ui/payloads';
import { useDialogEntity } from '@/lib/hooks/use-dialog-entity';

export interface AreasViewProps {
  areas: AreaWire[];
}

export function AreasView({ areas }: AreasViewProps): React.ReactElement {
  const [createOpen, setCreateOpen] = React.useState(false);
  const editing = useDialogEntity<AreaWire>();
  const talkingTo = useDialogEntity<AreaWire>();
  const sparkey = useSparkeyPronoun();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-muted-foreground text-sm">
          {areas.length > 0
            ? `${areas.length} ${areas.length === 1 ? 'part of your life' : 'parts of your life'}`
            : "Nothing here yet, and that's fine"}
        </div>

        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Add what matters
        </Button>
      </div>

      {areas.length === 0 ? (
        <EmptyState
          icon={Compass}
          title="What's going on in your life right now?"
          description={`Add a part of your life you want to keep in view, like career, health or family, and say why it matters right now. Sparkey uses this to understand your life when you search or ask ${sparkey.object} something.`}
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              Add the first
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {areas.map((area) => (
            <li
              key={area.id}
              className="bg-card flex flex-wrap items-center gap-2 rounded-md border p-3"
            >
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 shrink-0 rounded-full border"
                style={area.colour ? { backgroundColor: area.colour } : undefined}
              />

              <span className="font-medium">{area.name}</span>

              {area.archivedAt !== null && (
                <Badge variant="outline" className="text-[11px]">
                  archived
                </Badge>
              )}

              {area.description && (
                <span className="text-muted-foreground w-full text-xs">{area.description}</span>
              )}

              <span className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Tell me more about ${area.name}`}
                  onClick={() => talkingTo.open(area)}
                >
                  <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${area.name}`}
                  onClick={() => editing.open(area)}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <ArchiveControls
                  collection={RESPARKABLE_API.AREAS}
                  id={area.id}
                  label={area.name}
                  noun="area"
                  archived={area.archivedAt !== null}
                  compact
                />
              </span>
            </li>
          ))}
        </ul>
      )}

      <AreaForm open={createOpen} onOpenChange={setCreateOpen} />
      <AreaForm
        open={editing.entity !== null}
        onOpenChange={editing.onOpenChange}
        {...(editing.entity ? { area: editing.entity } : {})}
      />
      {talkingTo.entity && (
        <ContextChatDrawer
          open
          onOpenChange={talkingTo.onOpenChange}
          entityType="area"
          entityId={talkingTo.entity.id}
          entityName={talkingTo.entity.name}
          currentDescription={talkingTo.entity.description}
        />
      )}
    </div>
  );
}
