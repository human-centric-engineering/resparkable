'use client';

/**
 * CreateDialog — the chat/form choice for a new Area, Goal, Project or time block.
 *
 * One `<Dialog>`, not two. An earlier version swapped between a chat-only
 * dialog and the plain `<ResourceDialog>` form when the toggle changed —
 * two separate Radix dialog trees, so the switch remounted the whole thing:
 * the box changed height and popped instead of transitioning, and the
 * in-progress conversation was thrown away the moment someone peeked at the
 * form. This mounts both panes side by side inside one fixed-height dialog
 * and slides between them, so the height never jumps and neither pane loses
 * its state when the other is showing.
 *
 * The inactive pane gets `inert`: off-screen but still in the DOM (that's
 * what makes the slide possible), so without it its inputs would still be
 * tab-reachable and readable to a screen reader as if visible.
 *
 * Bound to `resparkable-companion`, not `resparkable-context`: creating a row
 * needs the `resparkable_upsert_*` capabilities, which only the companion
 * holds — the context agent is deliberately narrow (capture only, see its own
 * header). No `entityContext` either — there is no entity yet, which is
 * exactly what distinguishes "create" from `ContextChatDrawer`'s "tell me
 * more about this existing one".
 *
 * There's no way to know client-side that a create call landed via chat — the
 * stream reports which tool ran, not its result (see resparkable-chat.tsx's
 * own note on why). So the dialog refreshes the list on *any* close, chat or
 * form, successful save or not — correct whichever path was taken.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { FieldValues, UseFormReturn } from 'react-hook-form';

import { ResparkableChat } from '@/components/resparkable/chat/resparkable-chat';
import {
  CreateModeToggle,
  type CreateMode,
} from '@/components/resparkable/creation/create-mode-toggle';
import { ResourceFormBody } from '@/components/resparkable/ui/resource-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RESPARKABLE_AGENT_SLUGS } from '@/lib/framework/resparkable/agents';
import { cn } from '@/lib/utils';

export type CreatableEntityType = 'area' | 'goal' | 'project' | 'time-block';

const NOUN: Record<CreatableEntityType, string> = {
  area: 'life area',
  goal: 'goal',
  project: 'project',
  'time-block': 'block of time',
};

const DIALOG_TITLE: Record<CreatableEntityType, string> = {
  area: 'New life area',
  goal: 'New goal',
  project: 'New project',
  'time-block': 'New time block',
};

const DIALOG_DESCRIPTION: Record<CreatableEntityType, string> = {
  area: 'Share your life area details.',
  goal: 'Share your goal details.',
  project: 'Share your project details.',
  'time-block': 'Block out some time.',
};

export interface CreateDialogProps<TValues extends FieldValues> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: CreatableEntityType;
  mode: CreateMode;
  onModeChange: (mode: CreateMode) => void;
  /** One of the `RESPARKABLE_API` collection constants. */
  collection: string;
  form: UseFormReturn<TValues>;
  /** Form values → request body. Per-form; see `resource-dialog.tsx`'s header note. */
  toBody: (values: TValues) => Record<string, unknown>;
  /** The form pane's fields. */
  children: React.ReactNode;
}

export function CreateDialog<TValues extends FieldValues>({
  open,
  onOpenChange,
  entityType,
  mode,
  onModeChange,
  collection,
  form,
  toBody,
  children,
}: CreateDialogProps<TValues>): React.ReactElement {
  const router = useRouter();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) router.refresh();
      }}
    >
      <DialogContent className="flex h-[75vh] max-h-[42rem] flex-col sm:max-w-xl">
        <DialogHeader>
          {/* `pr-8` keeps the toggle clear of the dialog's own close button,
              which is absolutely positioned at `top-4 right-4` — without it
              the two overlap at this width. */}
          <div className="flex items-start justify-between gap-3 pr-8">
            <DialogTitle>{DIALOG_TITLE[entityType]}</DialogTitle>
            <CreateModeToggle mode={mode} onChange={onModeChange} />
          </div>
          <DialogDescription>{DIALOG_DESCRIPTION[entityType]}</DialogDescription>
        </DialogHeader>

        {/* The carousel: both panes always mounted, `overflow-hidden` clips the
            one not showing rather than the dialog resizing to fit whichever is
            active. */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div
            className={cn(
              'flex h-full w-[200%] transition-transform duration-300 ease-in-out motion-reduce:transition-none',
              mode === 'form' && '-translate-x-1/2'
            )}
          >
            <div className="h-full w-1/2 shrink-0" inert={mode === 'form' ? true : undefined}>
              <ResparkableChat
                agentSlug={RESPARKABLE_AGENT_SLUGS.companion}
                placeholder={`What do you want to call this ${NOUN[entityType]}?`}
                heightClassName="h-full"
              />
            </div>
            <div
              className="h-full w-1/2 shrink-0 overflow-y-auto px-1 pb-1"
              inert={mode === 'chat' ? true : undefined}
            >
              <ResourceFormBody
                collection={collection}
                form={form}
                toBody={toBody}
                onSaved={() => onOpenChange(false)}
              >
                {children}
              </ResourceFormBody>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
