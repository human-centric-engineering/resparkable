/**
 * Image Capture Upload Validation
 *
 * Multipart validation for the one-shot vision-extraction endpoint the
 * capture box's camera button posts to. Mirrors `lib/validations/transcribe.ts`
 * field-for-field — same discriminated-union result shape, same pre-parse
 * content-length guard — because the two routes solve the same problem
 * (bytes in, text out, nothing persisted) for two different media types.
 */

import { errorResponse } from '@/lib/api/responses';
import { enforceContentLengthCap as genericContentLengthCap } from '@/lib/api/multipart-guard';

/**
 * 10 MB cap. Generous for a phone-camera JPEG (typically 2-5 MB) or a
 * screenshot, well under what would make a single vision request an
 * outsized one-off cost — the rate-limit sub-cap bounds frequency, this
 * bounds size.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Small headroom over `MAX_IMAGE_BYTES` for multipart boundaries. The
 * pre-parse guard rejects with `IMAGE_TOO_LARGE` when `Content-Length`
 * exceeds this value.
 */
export const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 4 * 1024;

export function enforceContentLengthCap(request: Request): Response | null {
  return genericContentLengthCap(request, {
    maxBytes: MAX_REQUEST_BYTES,
    errorCode: 'IMAGE_TOO_LARGE',
    errorMessage: 'Image file exceeds size limit',
    details: { image: [`Maximum size is ${MAX_IMAGE_BYTES} bytes`] },
  });
}

/**
 * Allowed image MIME types — the formats every vision-capable model in the
 * matrix accepts natively. Deliberately excludes `image/heic`/`image/heif`:
 * iOS Safari's file input can hand those over untouched, and providers
 * generally don't decode them, which would turn "photograph a note" into a
 * silent 415 for exactly the phone-camera path this button exists for. A
 * future revision could transcode client-side; today the capture button
 * requests `image/jpeg` explicitly (see `ImageCaptureButton`), so this list
 * is a server-side backstop, not the primary guard.
 */
export const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

export interface ImageCaptureUploadOk {
  ok: true;
  value: { file: File };
}

export interface ImageCaptureUploadErr {
  ok: false;
  response: Response;
}

export type ImageCaptureUploadResult = ImageCaptureUploadOk | ImageCaptureUploadErr;

function isAllowedImageMime(type: string): boolean {
  return (ALLOWED_IMAGE_MIMES as readonly string[]).includes(type.toLowerCase());
}

/**
 * Parse + validate the image-capture endpoint's multipart body. Returns a
 * `{ ok: true, value }` on success or `{ ok: false, response }` carrying the
 * appropriate 400/413/415 error response on failure.
 */
export function validateImageCaptureUpload(formData: FormData): ImageCaptureUploadResult {
  const file = formData.get('image');
  if (!(file instanceof File)) {
    return {
      ok: false,
      response: errorResponse('Missing image field', {
        code: 'MISSING_IMAGE',
        status: 400,
        details: { image: ['An image file must be supplied in the `image` form field'] },
      }),
    };
  }

  if (file.size === 0) {
    return {
      ok: false,
      response: errorResponse('Image file is empty', {
        code: 'IMAGE_EMPTY',
        status: 400,
      }),
    };
  }

  if (file.size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      response: errorResponse('Image file exceeds size limit', {
        code: 'IMAGE_TOO_LARGE',
        status: 413,
        details: { image: [`Maximum size is ${MAX_IMAGE_BYTES} bytes`] },
      }),
    };
  }

  if (!isAllowedImageMime(file.type)) {
    return {
      ok: false,
      response: errorResponse('Unsupported image MIME type', {
        code: 'IMAGE_INVALID_TYPE',
        status: 415,
        details: {
          image: [`Allowed types: ${ALLOWED_IMAGE_MIMES.join(', ')}`],
          received: [file.type || '<empty>'],
        },
      }),
    };
  }

  return { ok: true, value: { file } };
}
