'use client';

/**
 * ImageCaptureButton — photograph a whiteboard, a book page, a handwritten
 * note instead of typing it.
 *
 * ## Why this isn't a chat attachment
 *
 * The platform's image input (`AiAgent.enableImageInput`) is a turn addressed
 * to an agent inside a persisted conversation. There is no agent here — the
 * extracted text lands in a textarea the user edits and saves as their own
 * note, same contract as `VoiceCaptureButton` — so this posts to Resparkable's
 * own one-shot route (`/transcribe/image`) rather than attaching to a chat
 * turn. See that route's header comment and
 * `.context/framework/resparkable/phase-9-plan.md` §1b for why no shared
 * primitive existed for this the way `transcribe()` did for audio.
 *
 * ## The photo is never sent anywhere else
 *
 * `capture="environment"` opens the camera directly on a phone rather than the
 * photo library, and the file goes straight to the extraction route — never
 * persisted (same invariant the route's own audit comment states). If someone
 * wants the photo itself kept, `AttachButton`'s "Add to Documents" path is
 * for that; this button is for the words in it.
 *
 * ## State machine
 *
 *   idle ── file chosen ──> extracting ── done ──> idle
 *                                        └── error ──> idle
 */

import * as React from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { cn } from '@/lib/utils';

export interface ImageCaptureButtonProps {
  /** Called with the extracted text. The caller decides where the words go. */
  onExtracted: (text: string) => void;
  /** Called with a sentence written for the user; this button renders no errors itself. */
  onError: (message: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * The wire shape, validated rather than asserted — `response.json()` is
 * external data even when we wrote the endpoint (CLAUDE.md).
 */
const extractionResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z.object({ text: z.string() }).optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
});

/**
 * Server codes, said in terms of what the person can do about it — same
 * pattern `VoiceCaptureButton` uses for its own error mapping.
 */
function imageErrorMessage(code: string | undefined, fallback: string): string {
  switch (code) {
    case 'IMAGE_DISABLED':
      return 'Image capture is switched off on this instance. An admin can turn it back on.';
    case 'NO_VISION_PROVIDER':
    case 'AGENT_NOT_SEEDED':
      return 'No vision-capable model is set up yet. An admin needs to configure one.';
    case 'IMAGE_TOO_LARGE':
      return 'That photo is too large. Try a smaller image.';
    case 'IMAGE_INVALID_TYPE':
      return 'This browser captured a format we can’t read. Try another camera app.';
    case 'RATE_LIMITED':
      return 'That’s a lot of photos in a short time. Give it a minute.';
    default:
      return fallback;
  }
}

export function ImageCaptureButton({
  onExtracted,
  onError,
  disabled = false,
  className,
}: ImageCaptureButtonProps): React.ReactElement {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [extracting, setExtracting] = React.useState(false);

  async function handleFile(file: File): Promise<void> {
    setExtracting(true);
    try {
      const form = new FormData();
      form.append('image', file);

      const response = await fetch(RESPARKABLE_API.TRANSCRIBE_IMAGE, {
        method: 'POST',
        body: form,
      });
      const raw: unknown = await response.json();
      const parsed = extractionResponseSchema.safeParse(raw);
      const body = parsed.success ? parsed.data : {};

      if (!response.ok || body.success !== true || !body.data?.text) {
        onError(
          imageErrorMessage(
            body.error?.code,
            body.error?.message ?? 'That photo didn’t come back as words.'
          )
        );
        return;
      }

      onExtracted(body.data.text);
    } catch {
      onError('Couldn’t reach the extraction service.');
    } finally {
      setExtracting(false);
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared immediately, same reason `AttachButton` does: a file input
          // only fires `change` when the selection *differs*, so photographing
          // the same frame twice in a row would otherwise do nothing.
          event.target.value = '';
          if (file) void handleFile(file);
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={extracting ? 'Reading your photo…' : 'Photograph a note'}
        onClick={() => inputRef.current?.click()}
        disabled={disabled || extracting}
        className={cn('shrink-0', className)}
      >
        {extracting ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Camera className="h-4 w-4" aria-hidden="true" />
        )}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {extracting ? 'Reading your photo…' : ''}
      </span>
    </>
  );
}
