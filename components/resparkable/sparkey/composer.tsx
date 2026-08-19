'use client';

/**
 * Composer — the text box every Sparkey mode sends through.
 *
 * The draft is controlled from `SparkeyPane` rather than owned here: an
 * agent turn that "delivers nothing" (no reply content, no tool call) gives
 * the words back to the box instead of leaving an empty exchange in the
 * transcript, the same rule `resparkable-chat.tsx` follows — and only the
 * parent knows when that's happened, since it owns the transcript entry
 * the turn was writing into.
 *
 * Voice and image capture are reused exactly as `QuickCapture` wires them:
 * both hand back plain text via `onTranscript`/`onExtracted`, appended into
 * the same draft a keystroke would produce, never a separate input path.
 *
 * The mismatch prompt is local, ephemeral state — `classifyIntent` runs on
 * every keystroke, and a dismissal only lasts for the current draft.
 * Sending, clearing, or switching mode re-arms it on whatever's typed next.
 */

import * as React from 'react';
import { Loader2, Send } from 'lucide-react';

import { ImageCaptureButton } from '@/components/resparkable/layout/image-capture-button';
import { VoiceCaptureButton } from '@/components/resparkable/layout/voice-capture-button';
import { MismatchPrompt } from '@/components/resparkable/sparkey/mismatch-prompt';
import { ModeSelector } from '@/components/resparkable/sparkey/mode-selector';
import type { SparkeyMode } from '@/components/resparkable/sparkey/sparkey-types';
import { AutoGrowTextarea } from '@/components/resparkable/ui/auto-grow-textarea';
import { Button } from '@/components/ui/button';
import { classifyIntent } from '@/lib/framework/resparkable/ui/workspace/classify-intent';

const PLACEHOLDER: Record<SparkeyMode, string> = {
  chat: 'Ask about your own material…',
  capture: 'Capture a thought…',
  instruct: 'Tell Sparkey what to do…',
};

export interface ComposerProps {
  mode: SparkeyMode;
  onModeChange: (mode: SparkeyMode) => void;
  value: string;
  onValueChange: (value: string) => void;
  /**
   * `source` is only meaningful for a Capture-mode submit — `THOUGHT_SOURCES`
   * has real `voice`/`image` values, the same provenance `QuickCapture`
   * preserves. It's `undefined` whenever the draft's most recent content
   * came from typing rather than a capture button, same "only claim what
   * was actually observed" rule `QuickCapture` follows.
   */
  onSubmit: (text: string, source?: 'voice' | 'image') => void;
  disabled?: boolean;
}

export function Composer({
  mode,
  onModeChange,
  value,
  onValueChange,
  onSubmit,
  disabled = false,
}: ComposerProps): React.ReactElement {
  const [source, setSource] = React.useState<'voice' | 'image' | undefined>(undefined);
  const [mismatchDismissed, setMismatchDismissed] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);

  const suggested = classifyIntent(value);
  const showMismatch = value.trim().length > 0 && suggested !== mode && !mismatchDismissed;

  function append(text: string, newSource: 'voice' | 'image'): void {
    onValueChange(value.trim() ? `${value.replace(/\s+$/, '')} ${text}` : text);
    setSource(newSource);
    // Same re-arm as a keystroke (onChange, below) — a voice/image capture
    // can change what the draft reads like just as much as typing can, and
    // a prompt dismissed before the capture shouldn't suppress a genuinely
    // new suggestion after it.
    setMismatchDismissed(false);
    inputRef.current?.focus();
  }

  function submit(): void {
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) return;
    onSubmit(trimmed, source);
    onValueChange('');
    setSource(undefined);
    setMismatchDismissed(false);
  }

  return (
    <div className="border-border/60 space-y-2 border-t p-3">
      <div className="flex items-center justify-between gap-2">
        <ModeSelector mode={mode} onChange={onModeChange} />
      </div>

      {showMismatch && (
        <MismatchPrompt
          suggested={suggested}
          onSwitch={() => {
            onModeChange(suggested);
            setMismatchDismissed(false);
          }}
          onDismiss={() => setMismatchDismissed(true)}
        />
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}

      <div className="flex items-end gap-1.5">
        <AutoGrowTextarea
          ref={inputRef}
          value={value}
          onChange={(event) => {
            onValueChange(event.target.value);
            setSource(undefined);
            setMismatchDismissed(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={PLACEHOLDER[mode]}
          minRows={1}
          maxRows={8}
          disabled={disabled}
          aria-label="Message"
          className="flex-1"
        />
        <VoiceCaptureButton
          onTranscript={(text) => append(text, 'voice')}
          onError={setError}
          disabled={disabled}
        />
        <ImageCaptureButton
          onExtracted={(text) => append(text, 'image')}
          onError={setError}
          disabled={disabled}
        />
        <Button
          size="icon"
          onClick={submit}
          disabled={disabled || value.trim().length === 0}
          aria-label="Send"
        >
          {disabled ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      </div>
    </div>
  );
}
