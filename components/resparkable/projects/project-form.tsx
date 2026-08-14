'use client';

/**
 * ProjectForm — create or edit a project.
 *
 * A project is the unit that carries goal alignment and momentum down to its
 * tasks, so **Status** gets a `<FieldHelp>` saying so: it is not cosmetic.
 * `paused` and `abandoned` take the project out of the active list, and
 * `projectMomentum` decays from `lastActivityAt` either way — so "paused" is
 * the honest setting for something you have stopped working on, and leaving
 * it `active` makes the decay read as neglect.
 *
 * **Area is purely organisational.** There is no weekly time target and
 * nothing about an Area feeds the scorer — see
 * `.context/framework/resparkable/design-principles.md` on why that mechanic
 * was removed rather than hidden. Filing a project under an area is for your
 * own later reference, not an input to anything's ranking.
 *
 * The slug is not exposed. `resolveUniqueSlug` derives it from the name and
 * guarantees uniqueness per user; letting someone type one means a collision error
 * on a field they did not know existed.
 */

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { useCreateMode } from '@/components/resparkable/creation/create-mode-toggle';
import { CreateDialog } from '@/components/resparkable/creation/create-dialog';
import { ResourceDialog } from '@/components/resparkable/ui/resource-dialog';
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
import { Textarea } from '@/components/ui/textarea';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { AreaWire, ProjectWire } from '@/lib/framework/resparkable/ui/payloads';
import { PROJECT_STATUSES } from '@/lib/framework/resparkable/validations';

/** Sentinel: a `Select` cannot carry an empty string as a value. */
const NO_AREA = '__none__';

const STATUS_LABELS: Record<(typeof PROJECT_STATUSES)[number], string> = {
  idea: 'Idea — not started',
  active: 'Active — being worked on',
  paused: 'Paused — deliberately on hold',
  done: 'Done',
  abandoned: 'Abandoned',
};

/**
 * Form-shaped, not API-shaped.
 *
 * Inputs produce strings, so validating the API schema directly here would mean
 * fighting coercion inside the resolver and surfacing its messages — which are
 * written for API callers, not for someone filling in a form.
 */
const formSchema = z.object({
  name: z.string().trim().min(1, 'Give it a name').max(200),
  description: z.string().max(10_000),
  status: z.enum(PROJECT_STATUSES),
  areaId: z.string(),
});

type ProjectFormValues = z.infer<typeof formSchema>;

export interface ProjectFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  areas: AreaWire[];
  /** Absent for a create. */
  project?: ProjectWire;
}

export function ProjectForm({
  open,
  onOpenChange,
  areas,
  project,
}: ProjectFormProps): React.ReactElement {
  const defaults = React.useMemo<ProjectFormValues>(
    () => ({
      name: project?.name ?? '',
      description: project?.description ?? '',
      // `ProjectWire.status` is plain `string` — validate it against the enum the
      // form declares rather than asserting it. See CLAUDE.md: never `as` on
      // external data. `.catch` preserves the default-on-miss the cast relied on.
      status: formSchema.shape.status.catch('active').parse(project?.status),
      areaId: project?.areaId ?? NO_AREA,
    }),
    [project]
  );

  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onTouched',
    defaultValues: defaults,
  });

  // Reopening on a different row must not show the last one's values.
  React.useEffect(() => {
    if (open) form.reset(defaults);
  }, [open, defaults, form]);

  const toBody = (values: ProjectFormValues): Record<string, unknown> => ({
    name: values.name,
    // `null` rather than omitted: clearing the description has to actually
    // clear it, and the API schema distinguishes the two.
    description: values.description.trim() ? values.description.trim() : null,
    status: values.status,
    areaId: values.areaId === NO_AREA ? null : values.areaId,
  });

  const fields = (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="project-name">Name</Label>
        <Input id="project-name" {...form.register('name')} />
        {form.formState.errors.name && (
          <p className="text-destructive text-xs">{form.formState.errors.name.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="project-description">What is it?</Label>
        <Textarea id="project-description" rows={3} {...form.register('description')} />
        <p className="text-muted-foreground text-xs">
          Also what the connection engine reads, so a sentence of real detail makes better
          suggestions than a title repeated.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="project-status" className="flex items-center gap-1.5">
          Status
          <FieldHelp title="Project status">
            <p>
              <strong>Active</strong> keeps it in your lists. <strong>Paused</strong> takes it out
              without abandoning it.
            </p>
            <p>
              Worth setting honestly: momentum decays from the last activity either way, so a
              project left &ldquo;active&rdquo; while you ignore it reads as neglect and drags its
              tasks down the ranking.
            </p>
          </FieldHelp>
        </Label>
        <Select
          value={form.watch('status')}
          onValueChange={(value) =>
            form.setValue('status', value as ProjectFormValues['status'], { shouldTouch: true })
          }
        >
          <SelectTrigger id="project-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROJECT_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="project-area" className="flex items-center gap-1.5">
          Part of my life
          <FieldHelp title="Area">
            Which domain of your life this belongs to — Career, Health, Family. Purely
            organisational: it does not affect how this project&rsquo;s tasks are ranked.
          </FieldHelp>
        </Label>
        <Select
          value={form.watch('areaId')}
          onValueChange={(value) => form.setValue('areaId', value, { shouldTouch: true })}
        >
          <SelectTrigger id="project-area">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_AREA}>Not filed under an area</SelectItem>
            {areas.map((area) => (
              <SelectItem key={area.id} value={area.id}>
                {area.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );

  // Only create offers the chat/form choice — an existing project already has
  // "Tell me more" for chat-based elaboration.
  const [createMode, setCreateMode] = useCreateMode();
  if (!project) {
    return (
      <CreateDialog
        open={open}
        onOpenChange={onOpenChange}
        entityType="project"
        mode={createMode}
        onModeChange={setCreateMode}
        collection={RESPARKABLE_API.PROJECTS}
        form={form}
        toBody={toBody}
      >
        {fields}
      </CreateDialog>
    );
  }

  return (
    <ResourceDialog
      open={open}
      onOpenChange={onOpenChange}
      collection={RESPARKABLE_API.PROJECTS}
      id={project.id}
      title="Edit project"
      description="A body of work with tasks under it. Tasks inherit its goal alignment and momentum."
      form={form}
      toBody={toBody}
    >
      {fields}
    </ResourceDialog>
  );
}
