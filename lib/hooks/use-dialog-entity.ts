'use client';

/**
 * useDialogEntity — state for "which row is a dialog currently open for".
 *
 * `null` means closed; a row means open on that row. Closing (Escape, overlay
 * click, or the dialog's own close control) must clear back to `null` rather
 * than just hiding the dialog — otherwise reopening on a different row would
 * briefly render the previous row's data before the new props land.
 */

import * as React from 'react';

export interface DialogEntity<T> {
  entity: T | null;
  open: (entity: T) => void;
  onOpenChange: (open: boolean) => void;
}

export function useDialogEntity<T>(): DialogEntity<T> {
  const [entity, setEntity] = React.useState<T | null>(null);
  return {
    entity,
    open: setEntity,
    onOpenChange: (nextOpen) => {
      if (!nextOpen) setEntity(null);
    },
  };
}
