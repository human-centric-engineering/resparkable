'use client';

/**
 * ResourceDialog — the create/edit shell the four resource forms share.
 *
 * Projects, goals, areas and entities all need the same thing: a dialog, a submit
 * that POSTs or PATCHes depending on whether there is an id, an error surface for
 * the failures Zod cannot predict, and a refresh on success. Writing that four
 * times is four places for the error handling to drift — and error handling is
 * exactly the part that gets copied badly.
 *
 * ## The caller owns `useForm`, and that is deliberate
 *
 * An earlier version took the Zod schema and built the form itself. It does not
 * type: `zodResolver` needs the schema's input and output types to line up with the
 * form's field values, and a component generic over "some Zod schema" loses that
 * relationship — the errors are unfixable without an `as`, which is the one thing
 * this codebase does not do to make types quiet.
 *
 * So the form instance comes in fully typed from a caller that knows its own
 * fields, and the shell handles the parts that are genuinely identical.
 *
 * ## `toBody` stays per-form
 *
 * The API schemas are `.strict()`, so "omit the field" and "send null" are
 * different requests: one leaves a value alone, the other clears it. Only the form
 * knows which one an empty input means, so a generic serialiser here would have to
 * guess — and guessing wrong silently wipes data on edit.
 *
 * `mode: 'onTouched'` per `CLAUDE.md` — callers set it; validating on every
 * keystroke shouts at someone halfway through their first word.
 *
 * ## `ResourceFormBody` is split out, not inlined
 *
 * The Area/Goal/Project create flow (`<CreateDialog>`) needs the exact same
 * fields-to-request submit machinery, but inside a dialog it already owns
 * (one shared with a chat pane, sliding between the two) rather than one this
 * component draws itself. Splitting the `<form>` and its save/error/submit
 * plumbing out of the `<Dialog>`/`<DialogContent>` chrome is what lets both
 * callers share the former without either dragging the latter along.
 */

import * as React from 'react';
import type { FieldValues, UseFormReturn } from 'react-hook-form';

import { FormError } from '@/components/forms/form-error';
import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { useResparkableRefresh } from '@/components/resparkable/workspace/tabs/tab-refresh-context';
import { changeTypeForCollection } from '@/lib/framework/resparkable/ui/workspace/change-scope';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { APIClientError } from '@/lib/api/client';
import { resparkableApi } from '@/lib/framework/resparkable/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

export interface ResourceFormBodyProps<TValues extends FieldValues> {
  /** One of the `RESPARKABLE_API` collection constants. */
  collection: string;
  /** Present for an edit, absent for a create. */
  id?: string;
  /**
   * The edit token of the row being edited, when it has one (phase 58). Sent
   * with the save, so a save over somebody else's change is a 409 rather than
   * a silent overwrite.
   */
  rev?: number;
  form: UseFormReturn<TValues>;
  /** Form values → request body. Per-form; see the header note. */
  toBody: (values: TValues) => Record<string, unknown>;
  children: React.ReactNode;
  submitLabel?: string;
  /** Called after a successful POST/PATCH. Closing and refreshing is the caller's call. */
  onSaved: () => void;
}

/** What a person is told when somebody else saved first. */
export const EDIT_CONFLICT_MESSAGE =
  'Someone else changed this while you had it open. Their version has loaded behind this form; save again to replace it with yours.';

/** The `<form>` itself: fields, the API-error surface, save status, submit. No dialog chrome. */
export function ResourceFormBody<TValues extends FieldValues>({
  collection,
  id,
  rev,
  form,
  toBody,
  children,
  submitLabel,
  onSaved,
}: ResourceFormBodyProps<TValues>): React.ReactElement {
  const { state, message, run } = useSaveStatus();
  const refresh = useResparkableRefresh();

  const onSubmit = form.handleSubmit(async (values) => {
    const body = toBody(values);

    const ok = await run(
      () =>
        id
          ? resparkableApi.patch(RESPARKABLE_API.itemPath(collection, id), {
              body: rev === undefined ? body : { ...body, rev },
            })
          : resparkableApi.post(collection, { body }),
      (error) => {
        if (!(error instanceof APIClientError) || error.status !== 409 || !id) {
          return error instanceof Error ? error.message : 'Something went wrong';
        }
        // Somebody else saved first. Refetch the row underneath the form, which
        // brings the new `rev` in through props, and keep what this person typed:
        // a second save is then a deliberate replacement, not an accident.
        const changed = changeTypeForCollection(collection);
        refresh(changed ? { type: changed, id } : undefined);
        return EDIT_CONFLICT_MESSAGE;
      }
    );

    if (ok) onSaved();
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => void onSubmit(event)}
      // Native validation would fire before Zod and show browser-styled
      // bubbles that say less than our own messages.
      noValidate
    >
      {children}

      {/* The API's own message, for what Zod cannot predict — a slug collision,
          or a row archived while the dialog was open. */}
      {state === 'error' && message && <FormError message={message} />}

      <DialogFooter className="items-center gap-2 sm:justify-between">
        <SaveStatus state={state} message={state === 'error' ? null : message} />
        <Button type="submit" disabled={state === 'saving'}>
          {submitLabel ?? (id ? 'Save changes' : 'Create')}
        </Button>
      </DialogFooter>
    </form>
  );
}

export interface ResourceDialogProps<TValues extends FieldValues> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** One of the `RESPARKABLE_API` collection constants. */
  collection: string;
  /** Present for an edit, absent for a create. */
  id?: string;
  /** See {@link ResourceFormBodyProps.rev}. */
  rev?: number;
  title: string;
  description?: string;
  form: UseFormReturn<TValues>;
  /** Form values → request body. Per-form; see the header note. */
  toBody: (values: TValues) => Record<string, unknown>;
  children: React.ReactNode;
  submitLabel?: string;
}

export function ResourceDialog<TValues extends FieldValues>({
  open,
  onOpenChange,
  collection,
  id,
  rev,
  title,
  description,
  form,
  toBody,
  children,
  submitLabel,
}: ResourceDialogProps<TValues>): React.ReactElement {
  const refresh = useResparkableRefresh();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <ResourceFormBody
          collection={collection}
          {...(id ? { id } : {})}
          {...(rev !== undefined ? { rev } : {})}
          form={form}
          toBody={toBody}
          {...(submitLabel ? { submitLabel } : {})}
          onSaved={() => {
            onOpenChange(false);
            // Named from the collection, which is the only thing this generic
            // dialog knows about what it just wrote. `undefined` for a
            // collection no tab shows, which falls back to refreshing the
            // calling tab alone — the behaviour before changes were named.
            const changed = changeTypeForCollection(collection);
            refresh(changed ? { type: changed, ...(id ? { id } : {}) } : undefined);
          }}
        >
          {children}
        </ResourceFormBody>
      </DialogContent>
    </Dialog>
  );
}
