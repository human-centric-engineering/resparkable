'use client';

/**
 * ModePicker — Present's three-way Lightweight / Pre-planned deck / On-the-fly choice.
 *
 * Same segmented-control markup as Sparkey's `ModeSelector`
 * (`components/resparkable/sparkey/mode-selector.tsx`), generalized to a
 * second three-way enum rather than reused directly — `SparkeyMode` and
 * `PresentMode` are different types answering different questions, and a
 * shared generic component here would need a type parameter for a control
 * this small.
 */

import * as React from 'react';

import type { PresentMode } from '@/components/resparkable/workspace/present/present-types';
import { cn } from '@/lib/utils';

const OPTIONS: Array<{ value: PresentMode; label: string }> = [
  { value: 'lightweight', label: 'Lightweight' },
  { value: 'deck', label: 'Deck' },
  { value: 'on-the-fly', label: 'On the fly' },
];

export interface ModePickerProps {
  mode: PresentMode;
  onChange: (mode: PresentMode) => void;
}

export function ModePicker({ mode, onChange }: ModePickerProps): React.ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label="Present mode"
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
