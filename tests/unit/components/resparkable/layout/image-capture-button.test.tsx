/**
 * ImageCaptureButton tests.
 *
 * Mirrors `voice-capture-button.test.tsx`'s properties for the sibling
 * capture modality:
 *
 * - **The extracted text is handed back, never posted as a thought.** A photo
 *   that filed itself would file a misread the same way an unedited transcript
 *   would.
 * - **The route it posts to is Resparkable's one-shot extraction endpoint**, not
 *   a chat attachment — no `agentId` travels from the browser, because the
 *   route resolves attribution server-side.
 * - Errors are asserted as the sentence the user reads, because "no vision
 *   model configured" and "extraction failed" send someone looking in
 *   different places.
 *
 * @see components/resparkable/layout/image-capture-button.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ImageCaptureButton } from '@/components/resparkable/layout/image-capture-button';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function makeProps(overrides: Partial<React.ComponentProps<typeof ImageCaptureButton>> = {}) {
  return { onExtracted: vi.fn(), onError: vi.fn(), ...overrides };
}

describe('ImageCaptureButton', () => {
  it('opens the camera capture input on click', () => {
    render(<ImageCaptureButton {...makeProps()} />);

    const input = document.querySelector('input[type="file"]');
    expect(input).toHaveAttribute('accept', 'image/*');
    expect(input).toHaveAttribute('capture', 'environment');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hands the extracted text back instead of capturing a thought', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, data: { text: 'Buy milk, call the dentist' } })
    );

    const props = makeProps();
    render(<ImageCaptureButton {...props} />);

    const photo = new File(['x'], 'note.jpg', { type: 'image/jpeg' });
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, photo);

    await waitFor(() =>
      expect(props.onExtracted).toHaveBeenCalledWith('Buy milk, call the dentist')
    );
    expect(props.onError).not.toHaveBeenCalled();
  });

  it('posts to the image extraction route with no agentId from the browser', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { text: 'hello' } }));

    render(<ImageCaptureButton {...makeProps()} />);
    const photo = new File(['x'], 'note.jpg', { type: 'image/jpeg' });
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, photo);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/resparkable/transcribe/image');

    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get('agentId')).toBeNull();
    expect(body.get('image')).toBeInstanceOf(File);
  });

  it('turns a missing vision model into advice an admin can act on', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(503, { success: false, error: { code: 'NO_VISION_PROVIDER' } })
    );

    const props = makeProps();
    render(<ImageCaptureButton {...props} />);
    const photo = new File(['x'], 'note.jpg', { type: 'image/jpeg' });
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, photo);

    await waitFor(() => {
      expect(props.onError).toHaveBeenCalledWith(expect.stringContaining('vision-capable model'));
    });
    expect(props.onExtracted).not.toHaveBeenCalled();
  });

  it('reports a network failure without claiming the words were lost', async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValue(new Error('offline'));

    const props = makeProps();
    render(<ImageCaptureButton {...props} />);
    const photo = new File(['x'], 'note.jpg', { type: 'image/jpeg' });
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, photo);

    await waitFor(() => {
      expect(props.onError).toHaveBeenCalledWith(expect.stringContaining('extraction service'));
    });
  });

  it('lets the same photo be chosen twice in a row', async () => {
    // The input value is cleared immediately after each change, or a second
    // pick of the exact same file (common when retaking a shot and picking
    // the same filename) would fire no `change` event at all.
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { text: 'first' } }));

    render(<ImageCaptureButton {...makeProps()} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const photo = new File(['x'], 'note.jpg', { type: 'image/jpeg' });

    await user.upload(input, photo);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(input.value).toBe('');
  });
});
