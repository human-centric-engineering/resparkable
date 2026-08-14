'use client';

/**
 * The chat/form choice for creating an Area, Goal or Project.
 *
 * One shared preference (`resparkable.create-mode.v1`) across all three, not
 * three separate ones — a person who switches to the form for a goal almost
 * certainly wants the form for a project too, and three independent memories
 * would mean re-deciding the same thing three times.
 */

import * as React from 'react';

import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { cn } from '@/lib/utils';

export type CreateMode = 'chat' | 'form';

const CREATE_MODE_KEY = 'resparkable.create-mode.v1';

export function useCreateMode(): [CreateMode, (mode: CreateMode) => void] {
  const [mode, setMode] = useLocalStorage<CreateMode>(CREATE_MODE_KEY, 'chat');
  return [mode, setMode];
}

export interface CreateModeToggleProps {
  mode: CreateMode;
  onChange: (mode: CreateMode) => void;
}

export function CreateModeToggle({ mode, onChange }: CreateModeToggleProps): React.ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label="How to create this"
      className="bg-muted inline-flex shrink-0 items-center rounded-md p-0.5 text-xs"
    >
      {(['chat', 'form'] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={mode === option}
          onClick={() => onChange(option)}
          className={cn(
            'rounded px-2 py-1 font-medium capitalize transition-colors',
            mode === option
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
