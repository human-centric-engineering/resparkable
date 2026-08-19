'use client';

/**
 * MismatchPrompt — "this looks like it belongs in a different mode."
 *
 * `classifyIntent` (`classify-intent.ts`) is a cheap heuristic, not a
 * judgment — the prompt exists precisely because it can be wrong, so it
 * only ever suggests and is always dismissible without switching anything.
 * Dismissing clears for the current draft only; typing something new after
 * a send re-arms it.
 */

import * as React from 'react';
import { X } from 'lucide-react';

import type { SparkeyMode } from '@/components/resparkable/sparkey/sparkey-types';
import { Button } from '@/components/ui/button';

const MODE_LABEL: Record<SparkeyMode, string> = {
  chat: 'a question',
  capture: 'a note',
  instruct: 'an instruction',
};

export interface MismatchPromptProps {
  suggested: SparkeyMode;
  onSwitch: () => void;
  onDismiss: () => void;
}

export function MismatchPrompt({
  suggested,
  onSwitch,
  onDismiss,
}: MismatchPromptProps): React.ReactElement {
  return (
    <div className="bg-muted/60 flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5 text-xs">
      <span className="text-muted-foreground flex-1">
        This reads like {MODE_LABEL[suggested]} — switch to {suggested}?
      </span>
      <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onSwitch}>
        Switch
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </Button>
    </div>
  );
}
