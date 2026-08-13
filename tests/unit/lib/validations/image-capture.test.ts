/**
 * Image capture upload validator — boundary + abuse coverage.
 *
 * Mirrors `transcribe.test.ts`'s structure for the sibling validator: MIME
 * matching, size boundaries, the pre-parse content-length guard. No
 * `agentId`/`language` fields here — the image route resolves the agent
 * server-side and has no language hint to accept.
 */

import { describe, it, expect } from 'vitest';

import {
  ALLOWED_IMAGE_MIMES,
  MAX_IMAGE_BYTES,
  MAX_REQUEST_BYTES,
  enforceContentLengthCap,
  validateImageCaptureUpload,
} from '@/lib/validations/image-capture';

function reqWithContentLength(value: string | null): Request {
  // `Content-Length` is a forbidden header name per the fetch spec, so
  // happy-dom / undici strip it from a real `Request`. Duck-typed mock
  // instead — production code only calls `request.headers.get(...)`.
  const headers = new Headers();
  if (value !== null) headers.set('x-mock-content-length', value);
  return {
    headers: {
      get(name: string): string | null {
        if (name.toLowerCase() === 'content-length') {
          return headers.get('x-mock-content-length');
        }
        return headers.get(name);
      },
    },
  } as unknown as Request;
}

function fd(fields: Partial<{ image: File | string | null }>): FormData {
  const form = new FormData();
  if (fields.image instanceof File) form.set('image', fields.image);
  else if (typeof fields.image === 'string') form.set('image', fields.image);
  return form;
}

function imageFile(opts: { type?: string; size?: number; name?: string } = {}): File {
  const type = opts.type ?? 'image/jpeg';
  const size = opts.size ?? 64;
  const bytes = new Uint8Array(size);
  return new File([bytes], opts.name ?? 'photo.jpg', { type });
}

async function readError(result: ReturnType<typeof validateImageCaptureUpload>) {
  if (result.ok) throw new Error('expected validation failure');
  return JSON.parse(await result.response.text()) as {
    success: boolean;
    error: { code: string; details?: Record<string, unknown> };
  };
}

describe('validateImageCaptureUpload — image field', () => {
  it('returns MISSING_IMAGE when no image field is present', async () => {
    const result = validateImageCaptureUpload(fd({}));
    const body = await readError(result);
    expect(body.error.code).toBe('MISSING_IMAGE');
  });

  it('returns MISSING_IMAGE when image field is a string (not a File)', async () => {
    const result = validateImageCaptureUpload(fd({ image: 'not-a-file' }));
    const body = await readError(result);
    expect(body.error.code).toBe('MISSING_IMAGE');
  });

  it('returns IMAGE_EMPTY for a 0-byte file', async () => {
    const result = validateImageCaptureUpload(fd({ image: imageFile({ size: 0 }) }));
    const body = await readError(result);
    expect(body.error.code).toBe('IMAGE_EMPTY');
  });
});

describe('validateImageCaptureUpload — size boundaries', () => {
  it('accepts a file exactly at MAX_IMAGE_BYTES', () => {
    const result = validateImageCaptureUpload(fd({ image: imageFile({ size: MAX_IMAGE_BYTES }) }));
    expect(result.ok).toBe(true);
  });

  it('rejects a file at MAX_IMAGE_BYTES + 1 byte', async () => {
    const result = validateImageCaptureUpload(
      fd({ image: imageFile({ size: MAX_IMAGE_BYTES + 1 }) })
    );
    const body = await readError(result);
    expect(body.error.code).toBe('IMAGE_TOO_LARGE');
  });
});

describe('validateImageCaptureUpload — MIME matching', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])('accepts %s', (type) => {
    const result = validateImageCaptureUpload(fd({ image: imageFile({ type }) }));
    expect(result.ok).toBe(true);
  });

  it('matches MIME case-insensitively', () => {
    const result = validateImageCaptureUpload(fd({ image: imageFile({ type: 'IMAGE/JPEG' }) }));
    expect(result.ok).toBe(true);
  });

  it.each([
    ['', 'empty MIME'],
    ['application/octet-stream', 'generic binary'],
    ['image/heic', 'HEIC — see the module comment for why'],
    ['video/mp4', 'video container'],
    ['text/plain', 'text'],
    ['image', 'malformed (no slash)'],
  ])('rejects %s (%s)', async (type) => {
    const result = validateImageCaptureUpload(fd({ image: imageFile({ type }) }));
    const body = await readError(result);
    expect(body.error.code).toBe('IMAGE_INVALID_TYPE');
    expect(body.error.details?.received).toEqual([type || '<empty>']);
  });

  it('exposes the allow-list in error details so clients can self-correct', async () => {
    const result = validateImageCaptureUpload(fd({ image: imageFile({ type: 'image/heic' }) }));
    const body = await readError(result);
    expect(body.error.details?.image).toEqual([`Allowed types: ${ALLOWED_IMAGE_MIMES.join(', ')}`]);
  });
});

describe('enforceContentLengthCap — pre-parse body-size guard', () => {
  it('passes through when no Content-Length header is set', () => {
    expect(enforceContentLengthCap(reqWithContentLength(null))).toBeNull();
  });

  it('passes through when Content-Length is non-numeric', () => {
    expect(enforceContentLengthCap(reqWithContentLength('abc'))).toBeNull();
  });

  it('passes through when Content-Length is below MAX_REQUEST_BYTES', () => {
    expect(enforceContentLengthCap(reqWithContentLength('1024'))).toBeNull();
  });

  it('passes through when Content-Length is exactly MAX_REQUEST_BYTES', () => {
    expect(enforceContentLengthCap(reqWithContentLength(String(MAX_REQUEST_BYTES)))).toBeNull();
  });

  it('returns 413 IMAGE_TOO_LARGE when Content-Length exceeds MAX_REQUEST_BYTES', async () => {
    const response = enforceContentLengthCap(reqWithContentLength(String(MAX_REQUEST_BYTES + 1)));
    expect(response).not.toBeNull();
    expect(response?.status).toBe(413);
    const body = (await response!.json()) as {
      success: boolean;
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('IMAGE_TOO_LARGE');
    expect(body.error.details?.image).toEqual([`Maximum size is ${MAX_IMAGE_BYTES} bytes`]);
  });

  it('returns 413 for blatantly oversized claims (DoS attempt)', async () => {
    const response = enforceContentLengthCap(reqWithContentLength('1073741824'));
    expect(response?.status).toBe(413);
  });

  it('MAX_REQUEST_BYTES has at least 4 KB headroom over MAX_IMAGE_BYTES', () => {
    expect(MAX_REQUEST_BYTES).toBeGreaterThanOrEqual(MAX_IMAGE_BYTES + 4 * 1024);
  });
});

describe('validateImageCaptureUpload — happy path', () => {
  it('returns the parsed file for a well-formed body', () => {
    const file = imageFile({ type: 'image/png', size: 1024, name: 'whiteboard.png' });
    const result = validateImageCaptureUpload(fd({ image: file }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.file).toBe(file);
  });
});
