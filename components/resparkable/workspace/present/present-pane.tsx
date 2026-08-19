'use client';

/**
 * PresentPane — Present mode's top-level surface.
 *
 * Standalone, like Phase 4/5's `SparkeyPane`/`ActivityPane`: no
 * `WorkspaceProvider` dependency yet, and not wired into any layout.
 * Phase 8's cutover is where a real, currently-focused Graph tab's payload
 * gets threaded in as `payload`, and where this component's local state
 * (mode, selection, the built deck) would move into `WorkspaceProvider`'s
 * own ephemeral presentation state per the build plan's Architecture
 * section — deferred here for the same reason Sparkey and Activity were
 * left unwired: there is nothing yet for that shared state to coordinate
 * with.
 *
 * `payload` is a prop rather than something this component fetches for
 * itself, on purpose: the plan already flags "two independently-fetched
 * tabs on the same Graph focus" as an accepted rough edge for `GraphTab`
 * itself (§ Risks) — a *third*, silent fetch of the same neighbourhood
 * from inside Present mode would make that worse, not better. `null` means
 * "no Graph tab is open/focused yet," a real and expected state, not a
 * loading placeholder.
 *
 * ## Why the mic reuses `VoiceCaptureButton`, not just `useVoiceRecording`
 *
 * The build plan's own Architecture section says "mic button (reusing
 * `useVoiceRecording`)" — the raw hook. `VoiceCaptureButton`
 * (`components/resparkable/layout/voice-capture-button.tsx`) turned out to
 * already be exactly that hook plus MIME handling, the level meter,
 * elapsed-time display and `/transcribe` error messages, wrapped in a
 * generic `onTranscript`/`onError` contract with nothing capture-specific
 * baked in — Sparkey's own composer already reuses it as-is (Phase 4).
 * Rebuilding a second mic control on the bare hook would duplicate all of
 * that for no behavioural difference, which is exactly what CLAUDE.md's
 * "search before creating" rule is for. Recorded as a deliberate deviation
 * from the plan's literal wording in the build plan's deferred follow-ups.
 *
 * ## Why On-the-fly still calls `/transcribe` and that isn't "generation"
 *
 * `plan.md` §22.1.3 describes Sparkey *generating* slides from what's
 * said — that needs a model call, which this phase's scope decision #3
 * explicitly excludes. What's built here is narrower and honest about the
 * gap: dictation becomes one slide's content verbatim, the same
 * "deliberately dumb, no model call" contract Capture mode already holds
 * elsewhere in this app. `/transcribe` (speech-to-text) is existing
 * infrastructure, not a new capability, and turning words into words is
 * not synthesis.
 */

import * as React from 'react';
import { Presentation } from 'lucide-react';

import { DeckNavigator } from '@/components/resparkable/workspace/present/deck-navigator';
import { ModePicker } from '@/components/resparkable/workspace/present/mode-picker';
import { NodeSelector } from '@/components/resparkable/workspace/present/node-selector';
import type { PresentMode } from '@/components/resparkable/workspace/present/present-types';
import { VoiceCaptureButton } from '@/components/resparkable/layout/voice-capture-button';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import {
  buildSlidesFromSelection,
  type Slide,
} from '@/lib/framework/resparkable/ui/workspace/build-slides';
import type { GraphPayloadWire } from '@/lib/framework/resparkable/ui/payloads';

export interface PresentPaneProps {
  /** The currently-focused Graph tab's payload, or `null` if none is open. */
  payload: GraphPayloadWire | null;
}

function createId(): string {
  return crypto.randomUUID();
}

/** Mirrors `ThoughtCard`'s own title-from-content convention. */
function firstLine(content: string, max = 80): string {
  const line = content.split('\n')[0]?.trim() ?? '';
  const source = line.length > 0 ? line : content.trim();
  return source.length <= max ? source : `${source.slice(0, max - 1).trimEnd()}…`;
}

export function PresentPane({ payload }: PresentPaneProps): React.ReactElement {
  const [mode, setMode] = React.useState<PresentMode>('deck');
  const [selectedKeys, setSelectedKeys] = React.useState<Set<string>>(new Set());
  const [slides, setSlides] = React.useState<Slide[]>([]);
  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [micError, setMicError] = React.useState<string | null>(null);

  function changeMode(next: PresentMode): void {
    setMode(next);
    setSlides([]);
    setCurrentIndex(0);
  }

  function toggleNode(key: string): void {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function buildDeck(): void {
    if (!payload) return;
    setSlides(buildSlidesFromSelection(payload, selectedKeys));
    setCurrentIndex(0);
  }

  function appendDictatedSlide(text: string): void {
    setMicError(null);
    setSlides((current) => {
      const next = [
        ...current,
        {
          key: createId(),
          type: 'note',
          id: createId(),
          title: firstLine(text),
          body: text,
          connector: null,
        },
      ];
      // Jump to the slide just dictated — the point of On-the-fly is
      // narrating as each one lands, not reviewing from slide one.
      setCurrentIndex(next.length - 1);
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <ModePicker mode={mode} onChange={changeMode} />

      {mode === 'lightweight' && (
        <EmptyState
          icon={Presentation}
          title="Nothing to build"
          description="Lightweight is for talking with a prompt in hand, not a deck — pick Deck or On the fly for something to step through."
        />
      )}

      {mode === 'deck' &&
        (payload ? (
          <>
            <NodeSelector
              nodes={payload.nodes}
              selectedKeys={selectedKeys}
              onToggle={toggleNode}
              onBuild={buildDeck}
            />
            <DeckNavigator
              slides={slides}
              currentIndex={currentIndex}
              onPrev={() => setCurrentIndex((i) => Math.max(0, i - 1))}
              onNext={() => setCurrentIndex((i) => Math.min(slides.length - 1, i + 1))}
            />
          </>
        ) : (
          <EmptyState
            icon={Presentation}
            title="Nothing to build from yet"
            description="Open a Graph tab and come back — Deck mode builds from what's on screen there."
          />
        ))}

      {mode === 'on-the-fly' && (
        <>
          <div className="flex items-center gap-2">
            <VoiceCaptureButton onTranscript={appendDictatedSlide} onError={setMicError} />
            {micError && (
              <p role="alert" className="text-destructive text-xs">
                {micError}
              </p>
            )}
          </div>
          <DeckNavigator
            slides={slides}
            currentIndex={currentIndex}
            onPrev={() => setCurrentIndex((i) => Math.max(0, i - 1))}
            onNext={() => setCurrentIndex((i) => Math.min(slides.length - 1, i + 1))}
          />
        </>
      )}
    </div>
  );
}
