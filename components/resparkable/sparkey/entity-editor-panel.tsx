'use client';

/**
 * EntityEditorPanel — chat-or-form for editing an Area, Goal or Project.
 *
 * "Entity" here is the generic sense (a resource with a form), not
 * Resparkable's own People/Company `Entity` type — that domain object has
 * no chat-or-form editing story at all, since `ResparkableChat`'s
 * `entityContext` prop is itself scoped to `'area' | 'goal' | 'project'`
 * (see its own definition), and this panel can't offer a chat half for a
 * kind the agent has no context shape for.
 *
 * Adapts `create-dialog.tsx`'s sliding-pane technique — both halves always
 * mounted, `inert` on whichever is hidden, a `translate-x` transform
 * instead of swapping component trees — without the `Dialog` chrome that
 * technique was built inside. `EntityFormDialog` used to route an existing
 * resource to form-only precisely because it had nowhere to put a second,
 * edit-shaped chat option; this panel is that option, and is now what that
 * file's edit branch renders.
 *
 * Chrome-free is still the point of the shape, not an accident of where it
 * first landed. `EntityFormDialog` supplies the `Dialog` around it because an
 * "Edit" button in a detail view wants a modal; a caller that wants this
 * inline — Sparkey referencing the item under discussion, a pane with an edit
 * mode — mounts the same component with no dialog at all and passes
 * `className` to size it. Nothing in here assumes either.
 *
 * Mode is remembered under its own key, deliberately independent from
 * `useCreateMode`'s `resparkable.create-mode.v1` — a preference for
 * chat-first when creating something new says nothing about whether
 * editing an existing one should default the same way.
 */

import * as React from 'react';
import type { FieldValues, UseFormReturn } from 'react-hook-form';

import { ResparkableChat } from '@/components/resparkable/chat/resparkable-chat';
import {
  CreateModeToggle,
  type CreateMode,
} from '@/components/resparkable/creation/create-mode-toggle';
import { ResourceFormBody } from '@/components/resparkable/ui/resource-dialog';
import { RESPARKABLE_AGENT_SLUGS } from '@/lib/framework/resparkable/agents';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { cn } from '@/lib/utils';

export type EditableEntityType = 'area' | 'goal' | 'project';

const NOUN: Record<EditableEntityType, string> = {
  area: 'life area',
  goal: 'goal',
  project: 'project',
};

const EDIT_MODE_KEY = 'resparkable.edit-mode.v1';

function useEditMode(): [CreateMode, (mode: CreateMode) => void] {
  const [mode, setMode] = useLocalStorage<CreateMode>(EDIT_MODE_KEY, 'form');
  return [mode, setMode];
}

export interface EntityEditorPanelProps<TValues extends FieldValues> {
  entityType: EditableEntityType;
  entityId: string;
  collection: string;
  form: UseFormReturn<TValues>;
  toBody: (values: TValues) => Record<string, unknown>;
  onSaved: () => void;
  children: React.ReactNode;
  className?: string;
}

export function EntityEditorPanel<TValues extends FieldValues>({
  entityType,
  entityId,
  collection,
  form,
  toBody,
  onSaved,
  children,
  className,
}: EntityEditorPanelProps<TValues>): React.ReactElement {
  const [mode, setMode] = useEditMode();

  return (
    <div className={cn('flex h-full flex-col', className)}>
      <div className="flex items-center justify-end border-b p-2">
        <CreateModeToggle mode={mode} onChange={setMode} />
      </div>

      {/* Same carousel as `create-dialog.tsx`: both panes always mounted,
          `overflow-hidden` clips the one not showing rather than the panel
          resizing to fit whichever is active. */}
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
              entityContext={{ entityType, entityId }}
              placeholder={`Tell Sparkey what to change about this ${NOUN[entityType]}…`}
              heightClassName="h-full"
            />
          </div>
          <div
            className="h-full w-1/2 shrink-0 overflow-y-auto px-1 pb-1"
            inert={mode === 'chat' ? true : undefined}
          >
            <ResourceFormBody
              collection={collection}
              id={entityId}
              form={form}
              toBody={toBody}
              onSaved={onSaved}
            >
              {children}
            </ResourceFormBody>
          </div>
        </div>
      </div>
    </div>
  );
}
