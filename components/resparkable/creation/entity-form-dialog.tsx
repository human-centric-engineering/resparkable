'use client';

/**
 * EntityFormDialog — the create/edit switch shared by Area, Goal and Project forms.
 *
 * Create offers the chat/form choice (`CreateDialog`); edit does not, since an
 * existing resource already has "Tell me more" for chat-based elaboration. Which
 * branch renders is decided by `existingId` — the same signal `ResourceDialog`
 * and `ResourceFormBody` already use to choose POST vs PATCH.
 */

import * as React from 'react';
import type { FieldValues, UseFormReturn } from 'react-hook-form';

import {
  CreateDialog,
  type CreatableEntityType,
} from '@/components/resparkable/creation/create-dialog';
import { useCreateMode } from '@/components/resparkable/creation/create-mode-toggle';
import { ResourceDialog } from '@/components/resparkable/ui/resource-dialog';

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
