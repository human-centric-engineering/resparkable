'use client';

/**
 * DeckNavigator — steps through a built deck, one slide at a time.
 *
 * Renders the slide's `title`/`body` and, when the previous slide was
 * directly linked to this one in the graph, its `connector` — the
 * presenter's one-line reminder of why this idea follows the last (see
 * `build-slides.ts`). An empty deck (nothing built yet, or "Lightweight"
 * mode) renders nothing rather than a disabled shell with nowhere to go.
 *
 * A dictated on-the-fly slide has no separate title — `PresentPane` derives
 * one from the transcript's first line, so for a short dictation `title`
 * and `body` are the same string. Showing that string twice would read as
 * a rendering mistake, not a summary, so the body is skipped whenever it
 * doesn't add anything past the title.
 */

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import type { Slide } from '@/lib/framework/resparkable/ui/workspace/build-slides';
import { Button } from '@/components/ui/button';

export interface DeckNavigatorProps {
  slides: Slide[];
  currentIndex: number;
  onPrev: () => void;
  onNext: () => void;
}

export function DeckNavigator({
  slides,
  currentIndex,
  onPrev,
  onNext,
}: DeckNavigatorProps): React.ReactElement | null {
  if (slides.length === 0) return null;

  const slide = slides[Math.min(currentIndex, slides.length - 1)];
  if (!slide) return null;

  return (
    <div
      role="region"
      aria-label="Current slide"
      className="bg-card space-y-3 rounded-lg border p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {currentIndex + 1} of {slides.length}
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Previous slide"
            onClick={onPrev}
            disabled={currentIndex === 0}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Next slide"
            onClick={onNext}
            disabled={currentIndex >= slides.length - 1}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {slide.connector && (
        <p className="text-muted-foreground text-xs italic">Why this follows: {slide.connector}</p>
      )}

      <h3 className="text-lg font-semibold">{slide.title}</h3>
      {slide.body && slide.body !== slide.title && <p className="text-sm">{slide.body}</p>}
    </div>
  );
}
