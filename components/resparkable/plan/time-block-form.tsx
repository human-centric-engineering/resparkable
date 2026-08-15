'use client';

/**
 * TimeBlockForm — chat/form create for a block of time, matching Goal/Project/Area.
 *
 * Create-only: `DayPlanner` never edits a block today, only creates and
 * removes one, so there is no `ResourceDialog` edit branch here the way
 * `GoalForm`/`ProjectForm` have one for their existing rows.
 */

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { useCreateMode } from '@/components/resparkable/creation/create-mode-toggle';
import { CreateDialog } from '@/components/resparkable/creation/create-dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { AreaWire, ProjectWire } from '@/lib/framework/resparkable/ui/payloads';

const NONE = '__none__';

const formSchema = z
  .object({
    title: z.string().max(500),
    startAt: z.string().min(1, 'Required'),
    endAt: z.string().min(1, 'Required'),
    areaId: z.string(),
    projectId: z.string(),
  })
  .refine((values) => new Date(values.endAt) > new Date(values.startAt), {
    message: 'Must be after the start time',
    path: ['endAt'],
  });

type TimeBlockFormValues = z.infer<typeof formSchema>;

export interface TimeBlockFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `yyyy-mm-dd`, the day being planned — seeds the start/end defaults. */
  day: string;
  areas: AreaWire[];
  projects: ProjectWire[];
}

export function TimeBlockForm({
  open,
  onOpenChange,
  day,
  areas,
  projects,
}: TimeBlockFormProps): React.ReactElement {
  const defaults = React.useMemo<TimeBlockFormValues>(
    () => ({
      title: '',
      startAt: `${day}T09:00`,
      endAt: `${day}T10:00`,
      areaId: NONE,
      projectId: NONE,
    }),
    [day]
  );

  const form = useForm<TimeBlockFormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onTouched',
    defaultValues: defaults,
  });

  React.useEffect(() => {
    if (open) form.reset(defaults);
  }, [open, defaults, form]);

  const toBody = (values: TimeBlockFormValues): Record<string, unknown> => ({
    ...(values.title.trim() ? { title: values.title.trim() } : {}),
    // `datetime-local` gives no zone; `new Date()` reads it as local time, which
    // is what "block 2pm" means to the person typing it.
    startAt: new Date(values.startAt).toISOString(),
    endAt: new Date(values.endAt).toISOString(),
    ...(values.areaId !== NONE ? { areaId: values.areaId } : {}),
    ...(values.projectId !== NONE ? { projectId: values.projectId } : {}),
  });

  const fields = (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="block-title">What are you doing?</Label>
        <Input
          id="block-title"
          placeholder="Deep work on the Q4 launch"
          {...form.register('title')}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="block-start">From</Label>
          <Input id="block-start" type="datetime-local" {...form.register('startAt')} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="block-end">Until</Label>
          <Input id="block-end" type="datetime-local" {...form.register('endAt')} />
          {form.formState.errors.endAt && (
            <p className="text-destructive text-xs">{form.formState.errors.endAt.message}</p>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="block-area" className="flex items-center gap-1.5">
            Part of your life
            <FieldHelp title="Part of your life">
              Optional. Tag a block with what it was for, so your day makes sense when you look back
              at it. A block with no area still shows on your day.
            </FieldHelp>
          </Label>
          <Select
            value={form.watch('areaId')}
            onValueChange={(value) => form.setValue('areaId', value, { shouldTouch: true })}
          >
            <SelectTrigger id="block-area">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Nothing in particular</SelectItem>
              {areas.map((area) => (
                <SelectItem key={area.id} value={area.id}>
                  {area.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="block-project">On</Label>
          <Select
            value={form.watch('projectId')}
            onValueChange={(value) => form.setValue('projectId', value, { shouldTouch: true })}
          >
            <SelectTrigger id="block-project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No particular project</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </>
  );

  const [createMode, setCreateMode] = useCreateMode();

  return (
    <CreateDialog
      open={open}
      onOpenChange={onOpenChange}
      entityType="time-block"
      mode={createMode}
      onModeChange={setCreateMode}
      collection={RESPARKABLE_API.TIME_BLOCKS}
      form={form}
      toBody={toBody}
    >
      {fields}
    </CreateDialog>
  );
}
