'use client';

/**
 * AreaForm: a standing part of someone's life, and why it matters right now.
 *
 * Resparkable is a reflection and understanding tool, not an optimisation one
 * (`.context/framework/resparkable/design-principles.md`): there is no weekly
 * hour target here, and nothing about an Area feeds the priority scorer. The
 * only job of this form is to capture what the person named and why it's on
 * their mind. The `description` field is where that "why" goes.
 *
 * ## What an area is not
 *
 * Not a client, not a company, not a project. `ResparkableEntity` covers those and is
 * deliberately absent from the scorer (§1). An Area is a domain of someone's
 * life (Health, Career, Family), and using Areas for clients would blur that.
 */

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { ResourceDialog } from '@/components/resparkable/ui/resource-dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { AreaWire } from '@/lib/framework/resparkable/ui/payloads';

const formSchema = z.object({
  name: z.string().trim().min(1, 'Give it a name').max(200),
  description: z.string().max(10_000),
  colour: z.string().max(16),
});

type AreaFormValues = z.infer<typeof formSchema>;

export interface AreaFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  area?: AreaWire;
}

export function AreaForm({ open, onOpenChange, area }: AreaFormProps): React.ReactElement {
  const defaults = React.useMemo<AreaFormValues>(
    () => ({
      name: area?.name ?? '',
      description: area?.description ?? '',
      colour: area?.colour ?? '',
    }),
    [area]
  );

  const form = useForm<AreaFormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onTouched',
    defaultValues: defaults,
  });

  React.useEffect(() => {
    if (open) form.reset(defaults);
  }, [open, defaults, form]);

  return (
    <ResourceDialog
      open={open}
      onOpenChange={onOpenChange}
      collection={RESPARKABLE_API.AREAS}
      {...(area ? { id: area.id } : {})}
      title={area ? 'Edit this part of your life' : 'What matters right now?'}
      description="A standing part of your life — Career, Health, Family. Not a project and not a client."
      form={form}
      toBody={(values) => ({
        name: values.name,
        description: values.description.trim() ? values.description.trim() : null,
        colour: values.colour.trim() ? values.colour.trim() : null,
      })}
    >
      <div className="space-y-1.5">
        <Label htmlFor="area-name">Name</Label>
        <Input id="area-name" placeholder="Health" {...form.register('name')} />
        {form.formState.errors.name && (
          <p className="text-destructive text-xs">{form.formState.errors.name.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="area-description" className="flex items-center gap-1.5">
          Why this matters right now
          <FieldHelp title="Why this matters">
            Say what&rsquo;s going on: what&rsquo;s good, what&rsquo;s hard, what you want to be
            true. There&rsquo;s no right length and no scorecard reading it back to you.
          </FieldHelp>
        </Label>
        <Textarea
          id="area-description"
          rows={3}
          placeholder="What's going on here at the moment, and why it's on your mind…"
          {...form.register('description')}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="area-colour" className="flex items-center gap-1.5">
          Colour
          <FieldHelp title="Colour">
            Used as a dot beside tasks so you can see at a glance which part of your life a list
            belongs to. Any CSS colour.
          </FieldHelp>
        </Label>
        <Input id="area-colour" placeholder="#0d9488" {...form.register('colour')} />
      </div>
    </ResourceDialog>
  );
}
