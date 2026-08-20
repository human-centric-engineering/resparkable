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
 * Voice capture is reused exactly as `QuickCapture` wires it: it hands back
 * plain text via `onTranscript`, appended into the same draft a keystroke
 * would produce, never a separate input path. `AttachButton`/`AttachmentCard`
 * (`capture-attachment.tsx`) are the same reuse for a real file —
 * QuickCapture's own "read into the box, or file it to Documents" choice,
 * unmodified, rather than a second upload flow built for this composer
 * specifically. `ImageCaptureButton` (photo → OCR text) is deliberately
 * *not* one of this footer's controls — live review asked for the paperclip
 * alone, since it already covers "bring content in that isn't typing"; it's
 * still used elsewhere (`QuickCapture`, `PresentPane`), just not duplicated
 * here as a second attach affordance.
 *
 * ## The unified input box
 *
 * Modelled on Claude.ai's own composer, per live design review: one
 * bordered box holding the textarea and a footer row of controls, not a
 * textarea with buttons floating beside it. `AutoGrowTextarea` loses its
 * own border/background/focus-ring (`border-0 bg-transparent shadow-none
 * focus-visible:ring-0`) so the *box* — not the textarea — is what shows a
 * border and a focus ring (`focus-within:ring-1` on the wrapper). Attach
 * sits on the left of the footer; mic and send sit on the right, matching
 * the reference's layout. All three footer buttons render `size="sm"` for
 * the same reason: the base `Button`'s `icon` size is a fixed `h-9 w-9`,
 * which used to leave Send both a visible 4px taller *and* narrower than
 * `AttachButton`/`VoiceCaptureButton` beside it — those two size to their
 * icon's padding rather than a fixed box. `size="sm"` with no width
 * override is what matches Send to that same padding-driven width instead
 * of guessing a fixed one; a live-review catch, not a guess.
 *
 * The mismatch prompt is local, ephemeral state — `classifyIntent` runs on
 * every keystroke, and a dismissal only lasts for the current draft.
 * Sending, clearing, or switching mode re-arms it on whatever's typed next.
 */

import * as React from 'react';
import { Loader2, Send } from 'lucide-react';

import { AttachButton, AttachmentCard } from '@/components/resparkable/layout/capture-attachment';
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
  const [file, setFile] = React.useState<File | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);

  const suggested = classifyIntent(value);
  const showMismatch = value.trim().length > 0 && suggested !== mode && !mismatchDismissed;

  /**
   * `newSource` is omitted for text read out of an uploaded file — same as
   * `QuickCapture`'s own `append()`: `THOUGHT_SOURCES` has no distinct value
   * for "read from a file," so it falls through to the schema's `web`
   * default, same as anything typed.
   */
  function append(text: string, newSource?: 'voice' | 'image'): void {
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
      {notice && <p className="text-muted-foreground text-xs">{notice}</p>}

      {file && (
        <AttachmentCard
          file={file}
          onDismiss={() => setFile(null)}
          onExtracted={(text, info) => {
            append(text);
            setFile(null);
            setNotice(
              info.truncated
                ? `Read the first part — the file has ${info.characters.toLocaleString()} characters, more than fits here.`
                : 'Text read in — check it before sending.'
            );
          }}
          onUploaded={(info) => {
            setFile(null);
            setNotice(
              info.deduped
                ? 'Already in your documents — nothing new was added.'
                : 'Added to your documents.'
            );
          }}
        />
      )}

      <div className="border-input bg-card focus-within:ring-ring rounded-md border shadow-sm focus-within:ring-1">
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
          minRows={3}
          maxRows={8}
          disabled={disabled}
          aria-label="Message"
          className="border-0 bg-transparent shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex items-center gap-1">
            <AttachButton onFile={setFile} disabled={disabled} />
          </div>
          <div className="flex items-center gap-1.5">
            <VoiceCaptureButton
              onTranscript={(text) => append(text, 'voice')}
              onError={setError}
              disabled={disabled}
            />
            <Button
              size="sm"
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
      </div>

      {/* `font-sans` overrides the mono this composer would otherwise inherit
          from `SparkeyPane`'s `.terminal-surface` — a caption about the keys,
          not something the machine said, so it reads as a hint rather than
          more terminal output. */}
      <p className="text-muted-foreground px-1 font-sans text-xs">
        Enter to send · Shift+Enter for a new line
      </p>
    </div>
  );
}
