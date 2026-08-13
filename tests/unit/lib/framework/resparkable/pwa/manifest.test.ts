/**
 * Unit Tests: `RESPARKABLE_MANIFEST`.
 *
 * Pure data, and exactly the kind that fails silently: a typo in `start_url`
 * or a `share_target.params` key that doesn't match what
 * `app/(protected)/resparkable/capture/page.tsx` reads is invisible until
 * someone actually shares a page from their phone.
 *
 * @see lib/framework/resparkable/pwa/manifest.ts
 */

import { describe, it, expect } from 'vitest';

import { RESPARKABLE_MANIFEST } from '@/lib/framework/resparkable/pwa/manifest';

describe('RESPARKABLE_MANIFEST', () => {
  it('opens on Today, standalone', () => {
    expect(RESPARKABLE_MANIFEST.start_url).toBe('/resparkable');
    expect(RESPARKABLE_MANIFEST.display).toBe('standalone');
  });

  it('declares a GET share target pointed at the capture page', () => {
    // POST would need a service-worker fetch handler this tier doesn't ship —
    // see the manifest's own header comment for why GET is deliberate.
    expect(RESPARKABLE_MANIFEST.share_target).toMatchObject({
      action: '/resparkable/capture',
      method: 'GET',
      params: { title: 'title', text: 'text', url: 'url' },
    });
  });

  it('carries an any-purpose icon at 192 and 512, plus a maskable 512', () => {
    const icons = RESPARKABLE_MANIFEST.icons ?? [];
    const bySize = new Map(icons.map((icon) => [`${icon.sizes}:${icon.purpose}`, icon]));

    expect(bySize.get('192x192:any')?.src).toBe('/icons/icon-192.png');
    expect(bySize.get('512x512:any')?.src).toBe('/icons/icon-512.png');
    expect(bySize.get('512x512:maskable')?.src).toBe('/icons/icon-512-maskable.png');
  });

  it('shortcuts to Capture, Today and Inbox', () => {
    const urls = (RESPARKABLE_MANIFEST.shortcuts ?? []).map((s) => s.url);
    expect(urls).toEqual(['/resparkable/capture', '/resparkable', '/resparkable/inbox']);
  });

  it('uses the same colour for background and theme, matching the icon ground', () => {
    expect(RESPARKABLE_MANIFEST.background_color).toBe('#10121a');
    expect(RESPARKABLE_MANIFEST.theme_color).toBe('#10121a');
  });
});
