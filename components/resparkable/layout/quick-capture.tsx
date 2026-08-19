'use client';

/**
 * QuickCapture — the box that is present on every Resparkable page.
 *
 * ## Why it lives in the shell rather than on a capture page
 *
 * The inbox is the front door of the product (`services/inbox.ts`), and the
 * quality of a second brain is decided almost entirely by whether capture is
 * frictionless. A thought you have while looking at the projects list has to land
 * *from there*, in one keystroke, or it doesn't land at all — and an idea that
 * needed a page navigation to record is an idea the tool lost.
 *
 * So: `⌘K` opens the sidekick and lands the caret here, `⌘/Ctrl+Enter` saves, the
 * box clears immediately, and nothing ever navigates away. Triage happens later
 * in `/resparkable/inbox`; this control's only job is to not lose the thought.
 *
 * ## Optimistic, but honest about failure
 *
 * The textarea clears the instant you submit, because waiting on a round trip to
 * confirm makes rapid capture feel broken. If the POST then fails, the text comes
 * **back into the box** with the error — never a toast over an empty field, which
 * is how you lose the one thing you were trying not to lose.
 *
 * ## Four ways in, one destination — and `source` follows the most recent one
 *
 * Typing, dictating, photographing and dropping a file all end in the same
 * textarea rather than each posting something of their own. A transcript is
 * edited before it is saved because dictation mishears; a photo's extracted
 * text the same, because a phone camera at an angle misreads too. Extracted
 * document text is cut down to the part that mattered. All of these are
 * *drafts* until a person presses Capture — which is the property that makes
 * it safe to make the easy paths this easy.
 *
 * The box also remembers whether the words on screen most recently arrived by
 * dictation or photo, and says so. `append()` takes an optional source, set by
 * `VoiceCaptureButton` to `'voice'` and `ImageCaptureButton` to `'image'`; any
 * keystroke in the textarea — including editing a transcript after the fact —
 * clears it back to unset, which is what sends as the schema's own default,
 * `'web'`. Extracted document text does the same: `THOUGHT_SOURCES` has no
 * distinct value for "read out of a file", so it is `'web'` too, same as
 * anything typed. A client naming its own source would be unreliable if it
 * could claim provenance it didn't have; this can't; it can only report what
 * this box itself just did.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Send } from 'lucide-react';

import { AttachButton, AttachmentCard } from '@/components/resparkable/layout/capture-attachment';
import { ImageCaptureButton } from '@/components/resparkable/layout/image-capture-button';
import { VoiceCaptureButton } from '@/components/resparkable/layout/voice-capture-button';
import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { cn } from '@/lib/utils';

export interface QuickCaptureProps {
  /**
   * Bump to move focus into the box. The sidekick raises it when the panel opens
   * so `⌘K` lands the caret here without this component needing to know whether
   * the drawer it lives in is open.
   */
  focusSignal?: number;
  /** Additional classes for the form element — the shell stretches it to full height. */
  className?: string;
  /**
   * Pre-fills the box — the share-target landing page's whole reason to use
   * this component rather than a bare textarea (`app/(resparkable)/resparkable/capture/page.tsx`).
   * Still a draft: nothing is sent until Capture is pressed, same as anything
   * typed by hand.
   */
  initialValue?: string;
  /** Paired with `initialValue` — `'pwa'` when the box was pre-filled from a share intent. */
  initialSource?: 'voice' | 'image' | 'pwa';
}

export function QuickCapture({
  focusSignal,
  className,
  initialValue,
  initialSource,
}: QuickCaptureProps = {}): React.ReactElement {
  const router = useRouter();
  const { state, message, run } = useSaveStatus();
  const [value, setValue] = React.useState(initialValue ?? '');
  const [file, setFile] = React.useState<File | null>(null);
  /**
   * Undefined means "let the schema default to `web`". Set by `append()` when the
   * text it just added came from a capture modality worth recording; cleared by
   * any manual keystroke, because editing the box by hand is itself what makes
   * `web` the honest answer again. Seeded from `initialSource` for the one case
   * where provenance is known before the box even mounts — a share-target open.
   */
  const [source, setSource] = React.useState<'voice' | 'image' | 'pwa' | undefined>(initialSource);
  /** Said in the status line under the box: transcription errors, "read 4,000 characters", etc. */
  const [note, setNote] = React.useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (focusSignal === undefined) return;
    inputRef.current?.focus();
  }, [focusSignal]);

  /**
   * Append rather than replace: dictated and extracted text join what you already
   * wrote. `newSource` is omitted for document extraction (no distinct source
   * value exists for it — see the header note) and passed by the capture buttons
   * that do have one.
   */
  const append = React.useCallback((text: string, newSource?: 'voice' | 'image') => {
    setValue((current) => (current.trim() ? `${current.replace(/\s+$/, '')}\n\n${text}` : text));
    setSource(newSource);
    inputRef.current?.focus();
  }, []);

  async function submit(): Promise<void> {
    const content = value.trim();
    if (!content) return;
    const capturedSource = source;

    // Cleared before the await — see the header note.
    setValue('');
    setSource(undefined);
    setNote(null);

    const ok = await run(() =>
      apiClient.post(RESPARKABLE_API.THOUGHTS, {
        body: { content, ...(capturedSource ? { source: capturedSource } : {}) },
      })
    );

    if (ok) {
      // The inbox count in the nav and any inbox list on screen are now stale.
      router.refresh();
    } else {
      // Give the words (and their source) back. Losing them is the one
      // unforgivable failure here.
      setValue(content);
      setSource(capturedSource);
      inputRef.current?.focus();
    }
  }

  return (
    <form
      className={cn('flex min-h-0 flex-col gap-2', className)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onDragOver={(event) => {
        // Only claim the drop when it is actually carrying files, so dragging a
        // text selection around the page doesn't light the box up.
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(false);
        const dropped = event.dataTransfer.files[0];
        if (dropped) {
          setFile(dropped);
          setNote(null);
        }
      }}
    >
      <label htmlFor="resparkable-quick-capture" className="sr-only">
        Capture a thought
      </label>
      <Textarea
        id="resparkable-quick-capture"
        ref={inputRef}
        value={value}
        placeholder="Capture a thought… (⌘↩ to save)"
        className={cn(
          // `flex-1` is what makes the box grow to the height of the drawer: a
          // two-row textarea inside a full-height panel is a smaller target than
          // the empty space beneath it, and the point of the panel is room to think.
          'min-h-24 flex-1 resize-none text-sm',
          // `.terminal-surface` on the box and NOT on the surrounding form: what
          // you type into a terminal is monospaced, the panel around it isn't.
          // The attachment card, the status notes and the buttons below stay in
          // the reading font — they are the app talking to you, and a mono button
          // label is just a wide button.
          'terminal-surface',
          dragging && 'border-primary ring-primary/30 ring-2'
        )}
        onChange={(event) => {
          setValue(event.target.value);
          setSource(undefined);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void submit();
          }
        }}
      />

      {file && (
        <AttachmentCard
          file={file}
          onDismiss={() => setFile(null)}
          onExtracted={(text, info) => {
            append(text);
            setFile(null);
            setNote({
              tone: 'info',
              text: info.truncated
                ? `Read the first part — the file has ${info.characters.toLocaleString()} characters, more than fits here.`
                : 'Text read in. Edit it down to what matters, then capture.',
            });
          }}
          onUploaded={(info) => {
            setFile(null);
            setNote({
              tone: 'info',
              text: info.deduped
                ? 'Already in your documents — same file, so nothing new was created.'
                : 'Added to your documents. It becomes searchable once indexed.',
            });
            router.refresh();
          }}
        />
      )}

      {note && (
        <p
          className={cn(
            'text-xs',
            note.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
          )}
          role={note.tone === 'error' ? 'alert' : 'status'}
        >
          {note.text}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <VoiceCaptureButton
            onTranscript={(text) => {
              append(text, 'voice');
              setNote({ tone: 'info', text: 'Transcribed — check it reads right before saving.' });
            }}
            onError={(text) => setNote({ tone: 'error', text })}
            disabled={state === 'saving'}
          />
          <ImageCaptureButton
            onExtracted={(text) => {
              append(text, 'image');
              setNote({ tone: 'info', text: 'Read from your photo — check it before saving.' });
            }}
            onError={(text) => setNote({ tone: 'error', text })}
            disabled={state === 'saving'}
          />
          <AttachButton onFile={(chosen) => setFile(chosen)} disabled={state === 'saving'} />
        </div>
        <Button type="submit" size="sm" disabled={!value.trim() || state === 'saving'}>
          <Send className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Capture
        </Button>
      </div>

      <SaveStatus
        state={state}
        message={message ?? (state === 'saved' ? 'Captured — it’s in your inbox' : null)}
      />

      <p className="text-muted-foreground text-[11px]">
        Drop a file here to read it in or file it — PDF, Word, EPUB, CSV, HTML, Markdown or text.
      </p>
    </form>
  );
}
