'use client';

/**
 * Where this thought is going, said out loud before it goes there.
 *
 * ## The default is personal, on every path, always
 *
 * Not "the workspace you are looking at". That is the whole point of this
 * control existing, and it is the acceptance criterion for phase 47 (test 13e):
 * a thought landing in a shared brain because the last workspace was sticky is
 * the mortifying failure this feature has, and it is mortifying precisely
 * because nothing goes wrong on screen. The capture succeeds, the box clears,
 * and four other people can read it.
 *
 * So the capture box does not inherit the ambient `?space=`. It starts on
 * personal every time, and putting a thought in a group is a thing you choose,
 * once, per thought. The cost is a click for somebody working in a group all
 * day; the alternative cost is unrecoverable.
 *
 * ## Sensitivity warns and never filters
 *
 * `classifyThoughtSensitivity` is the same pure keyword pass the server runs on
 * capture, reused here so the warning appears while the words are still in the
 * box rather than after they have landed. It is a **warning**, and no query
 * anywhere reads it to hide a row: using sensitivity to filter what a group
 * member sees would build §23.4's forbidden per-row ACL through a side door,
 * one well-meaning `where` clause at a time.
 *
 * It is also deliberately not a block. The classifier is broad and wrong often
 * enough that refusing the capture would train people to route around it, and a
 * person who means to tell their group about their week is not making a
 * mistake.
 *
 * ## It disappears when there is nothing to choose
 *
 * Somebody in no group has one workspace, and a control offering one option is
 * a control that makes capture slower for no reason. Capture has to be faster
 * than thinking (`services/capture.ts`), and this is the first thing that would
 * get in the way of that.
 *
 * @see .context/framework/resparkable/plan.md: §23.4
 */

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';

import { useOpenableSpaces } from '@/components/resparkable/shell/spaces-context';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { classifyThoughtSensitivity } from '@/lib/framework/resparkable/services/sensitivity';

/** The `<Select>` value that means the personal space. See `PERSONAL_VALUE`. */
const PERSONAL_VALUE = '__personal__';

export interface CaptureTargetProps {
  /** The chosen space id, or `null` for personal. */
  value: string | null;
  onChange: (spaceId: string | null) => void;
  /** What is currently in the box, for the sensitivity warning. */
  content: string;
  className?: string;
}

/**
 * The default a capture control should start on, and return to after a save.
 *
 * A function rather than a constant so the reason travels with it: personal,
 * every time, regardless of which workspace is open.
 */
export function defaultCaptureTarget(): string | null {
  return null;
}

export function CaptureTarget({
  value,
  onChange,
  content,
  className,
}: CaptureTargetProps): React.ReactElement | null {
  const spaces = useOpenableSpaces();
  const groups = spaces.filter((space) => space.kind === 'group');

  if (groups.length === 0) return null;

  const target = groups.find((space) => space.spaceId === value) ?? null;

  // Only when it is actually going somewhere shared, and only when there are
  // words to judge. A warning on an empty box is noise that teaches people to
  // stop reading warnings.
  const warn =
    target !== null && content.trim().length > 0
      ? classifyThoughtSensitivity(content) === 'sensitive'
      : false;

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground shrink-0 text-[11px]">Save to</span>
        <Select
          value={value ?? PERSONAL_VALUE}
          onValueChange={(next) => onChange(next === PERSONAL_VALUE ? null : next)}
        >
          <SelectTrigger className="h-7 w-auto min-w-[9rem] text-xs" aria-label="Save this to">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* Personal first and selected by default, on every capture. */}
            <SelectItem value={PERSONAL_VALUE}>
              {spaces.find((space) => space.kind === 'personal')?.name ?? 'Personal'}
            </SelectItem>
            {groups.map((space) => (
              <SelectItem key={space.spaceId} value={space.spaceId}>
                {space.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {warn && (
        <p
          className="text-muted-foreground mt-1.5 flex items-start gap-1.5 text-[11px]"
          // Announced when it appears, because it appears while somebody is
          // typing and may never be looked at directly.
          role="status"
        >
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
          <span>This reads as personal. Everyone in {target?.name} will be able to see it.</span>
        </p>
      )}
    </div>
  );
}
