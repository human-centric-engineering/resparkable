/**
 * Rasterises `public/brand/resparkable-icon.svg` into the PNG set
 * `app/manifest.ts` references. Re-run whenever the source SVG changes.
 *
 * Two purposes, three files:
 *   - `icon-192.png` / `icon-512.png` (`purpose: 'any'`) — the icon rendered
 *     as-is. Its own background rect already fills the canvas edge-to-edge
 *     (bar the `rx="13"` corners), so no extra work is needed here.
 *   - `icon-512-maskable.png` (`purpose: 'maskable'`) — the same icon
 *     rendered smaller (80% of the canvas) and composited onto a full-bleed
 *     square in the icon's own background colour. Android/iOS apply an
 *     arbitrary mask shape (circle, squircle, rounded square) to a maskable
 *     icon, and anything outside the ~80% "safe zone" can be clipped — this
 *     is what keeps the loop-and-spark artwork inside that zone regardless
 *     of which shape a launcher picks. The seam between the composited icon's
 *     own rounded-rect background and the outer canvas is invisible because
 *     both are the same fill (`#10121a`).
 *
 * Run with: npm run framework:resparkable:build-pwa-icons
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(__dirname, '../../..');
const SOURCE_SVG = path.join(ROOT, 'public/brand/resparkable-icon.svg');
const OUT_DIR = path.join(ROOT, 'public/icons');

/** Matches the icon's own `<rect fill="#10121a">` background. */
const BACKGROUND = '#10121a';

async function renderAny(svg: Buffer, size: number): Promise<Buffer> {
  return sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();
}

async function renderMaskable(svg: Buffer, size: number): Promise<Buffer> {
  const inset = Math.round(size * 0.8);
  const icon = await sharp(svg, { density: 384 }).resize(inset, inset).png().toBuffer();

  return sharp({
    create: { width: size, height: size, channels: 4, background: BACKGROUND },
  })
    .composite([{ input: icon, gravity: 'center' }])
    .png()
    .toBuffer();
}

async function main(): Promise<void> {
  const svg = await readFile(SOURCE_SVG);
  await mkdir(OUT_DIR, { recursive: true });

  const outputs: Array<[string, Promise<Buffer>]> = [
    ['icon-192.png', renderAny(svg, 192)],
    ['icon-512.png', renderAny(svg, 512)],
    ['icon-512-maskable.png', renderMaskable(svg, 512)],
  ];

  for (const [name, bufferPromise] of outputs) {
    const buffer = await bufferPromise;
    await writeFile(path.join(OUT_DIR, name), buffer);
    console.log(`✓ public/icons/${name} (${buffer.byteLength} bytes)`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
