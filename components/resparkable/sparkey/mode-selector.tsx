'use client';

/**
 * ModeSelector — the composer's three-way Chat / Capture / Instruct choice.
 *
 * No separate "Auto" toggle, per the build plan: `classifyIntent`
 * (`classify-intent.ts`) only ever informs the dismissible mismatch prompt
 * above the composer, never routes silently on the user's behalf — the
 * mode you picked is the mode a message sends in, always.
 *
 * Same segmented-control markup as `CreateModeToggle`
 * (`components/resparkable/creation/create-mode-toggle.tsx`), generalized
 * from two options to three rather than reused directly — that component's
 * type and behavior are specifically "chat or form," not a generic toggle.
 */

import * as React from 'react';

import type { SparkeyMode } from '@/components/resparkable/sparkey/sparkey-types';
import { cn } from '@/lib/utils';

const OPTIONS: Array<{ value: SparkeyMode; label: string }> = [
  { value: 'chat', label: 'Chat' },
  { value: 'capture', label: 'Capture' },
  { value: 'instruct', label: 'Instruct' },
];

export interface ModeSelectorProps {
  mode: SparkeyMode;
  onChange: (mode: SparkeyMode) => void;
}

export function ModeSelector({ mode, onChange }: ModeSelectorProps): React.ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label="Composer mode"
      className="bg-muted inline-flex shrink-0 items-center rounded-md p-0.5 text-xs"
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={mode === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded px-2.5 py-1 font-medium transition-colors',
            mode === option.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
