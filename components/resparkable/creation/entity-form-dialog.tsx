'use client';

/**
 * EntityFormDialog — the create/edit switch shared by Area, Goal and Project forms.
 *
 * Both branches now offer the chat/form choice. Which one renders is decided
 * by `existingId` — the same signal `ResourceDialog` and `ResourceFormBody`
 * already use to choose POST vs PATCH — and they differ in what the chat half
 * is *for*: create talks to an agent with no subject yet (`CreateDialog`),
 * edit hands it the record under discussion (`EntityEditorPanel`'s
 * `entityContext`), so "make this one quarterly instead" has something to
 * refer to.
 *
 * This file used to say edit was deliberately form-only, on the grounds that
 * an existing resource already had "Tell me more" for chat. That was the
 * honest reading before `EntityEditorPanel` existed: "Tell me more"
 * (`ContextChatDrawer`) is bound to the *context* agent, which holds capture
 * only and cannot write a field. It elaborates; it does not edit. The panel
 * is bound to `resparkable-companion`, which holds the `resparkable_upsert_*`
 * capabilities, so the edit half can actually change the thing.
 *
 * ## The one kind that stays form-only
 *
 * `time-block`. `ResparkableChat`'s `entityContext` is scoped to
 * `'area' | 'goal' | 'project'`, so there is no context shape to hand the
 * agent for a block of time, and a chat pane that could not refer to what you
 * were editing would be worse than not offering one. It falls through to
 * `ResourceDialog`, exactly as every edit did before. Nothing routes a
 * time-block edit here today (`time-block-form.tsx` uses `CreateDialog`
 * directly), so this is the type system's question being answered rather than
 * a path anyone walks.
 *
 * ## Why the close handler announces the change
 *
 * There is no way to know client-side that an edit landed via chat: the
 * stream reports which tool ran, not its result (see `create-dialog.tsx`'s
 * own note). So the dialog announces on *any* close, chat or form, saved or
 * abandoned — correct whichever path was taken, and the cost of a false
 * positive is one refetch of the panes already showing this record.
 */

import * as React from 'react';
import type { FieldValues, UseFormReturn } from 'react-hook-form';

import {
  CreateDialog,
  type CreatableEntityType,
} from '@/components/resparkable/creation/create-dialog';
import { useCreateMode } from '@/components/resparkable/creation/create-mode-toggle';
import {
  EntityEditorPanel,
  type EditableEntityType,
} from '@/components/resparkable/sparkey/entity-editor-panel';
import { ResourceDialog } from '@/components/resparkable/ui/resource-dialog';
import { useResparkableRefresh } from '@/components/resparkable/workspace/tabs/tab-refresh-context';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface EntityFormDialogProps<TValues extends FieldValues> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: CreatableEntityType;
  /** One of the `RESPARKABLE_API` collection constants. */
  collection: string;
  /** Present for an edit, absent for a create. */
  existingId?: string;
  editTitle: string;
  editDescription?: string;
  form: UseFormReturn<TValues>;
  /** Form values → request body. Per-form; see `resource-dialog.tsx`'s header note. */
  toBody: (values: TValues) => Record<string, unknown>;
  /** The form pane's fields, shared by both the create and edit dialogs. */
  children: React.ReactNode;
}

/** Narrows to the three kinds the companion agent has an `entityContext` shape for. */
function isEditableByChat(entityType: CreatableEntityType): entityType is EditableEntityType {
  return entityType !== 'time-block';
}

export function EntityFormDialog<TValues extends FieldValues>({
  open,
  onOpenChange,
  entityType,
  collection,
  existingId,
  editTitle,
  editDescription,
  form,
  toBody,
  children,
}: EntityFormDialogProps<TValues>): React.ReactElement {
  const [createMode, setCreateMode] = useCreateMode();
  const refresh = useResparkableRefresh();

  if (!existingId) {
    return (
      <CreateDialog
        open={open}
        onOpenChange={onOpenChange}
        entityType={entityType}
        mode={createMode}
        onModeChange={setCreateMode}
        collection={collection}
        form={form}
        toBody={toBody}
      >
        {children}
      </CreateDialog>
    );
  }

  if (!isEditableByChat(entityType)) {
    return (
      <ResourceDialog
        open={open}
        onOpenChange={onOpenChange}
        collection={collection}
        id={existingId}
        title={editTitle}
        description={editDescription}
        form={form}
        toBody={toBody}
      >
        {children}
      </ResourceDialog>
    );
  }

  // Same reason `CreateDialog` routes its own closes through one handler:
  // Radix only fires `onOpenChange` for its own close triggers, so a save
  // that flips the controlled `open` prop would skip the refresh entirely.
  const handleOpenChange = (next: boolean): void => {
    onOpenChange(next);
    if (!next) refresh({ type: entityType, id: existingId });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* Fixed height, matching `CreateDialog`'s: the panel slides between two
          panes of different natural heights, and a dialog that resized to fit
          whichever was showing would jump on every toggle. */}
      <DialogContent className="flex h-[75vh] max-h-[42rem] flex-col sm:max-w-xl">
        <DialogHeader>
          {/* `pr-8` clears the dialog's own absolutely-positioned close button,
              which the panel's mode toggle would otherwise sit under. */}
          <div className="pr-8">
            <DialogTitle>{editTitle}</DialogTitle>
          </div>
          {editDescription && <DialogDescription>{editDescription}</DialogDescription>}
        </DialogHeader>

        <EntityEditorPanel
          entityType={entityType}
          entityId={existingId}
          collection={collection}
          form={form}
          toBody={toBody}
          onSaved={() => handleOpenChange(false)}
          className="min-h-0 flex-1"
        >
          {children}
        </EntityEditorPanel>
      </DialogContent>
    </Dialog>
  );
}
