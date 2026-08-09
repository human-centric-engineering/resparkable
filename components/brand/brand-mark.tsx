import { SparkWordmark } from '@/components/brand/spark-wordmark';
import { LOOP_PATH, SPARK_PATH } from '@/components/brand/geometry';
import {
  BrandGradientDefs,
  BRAND_LOOP_GRADIENT_ID,
  BRAND_SPARK_GRADIENT_ID,
} from '@/components/brand/brand-gradients';
import { cn } from '@/lib/utils';

/**
 * BrandMark — the header/footer brand slot.
 *
 * **Fork-owned scaffold** — Sunrise ships this and does NOT change it after
 * release, so edits here merge cleanly on upgrade (the stable contract is this
 * file's export, not its body). Treat it like the landing page: a starting point
 * you're expected to modify. Full guide: CUSTOMIZATION.md §2.
 *
 * Lives in `components/` rather than `lib/app/` because the `lib/app/**` ESLint
 * boundary bans runtime `next/*` imports and a logo commonly needs `next/image`.
 *
 * ## The loop and the spark
 *
 * An infinity loop built only from straight facets, with a four-point spark on
 * the crossing: a spark captured, carried round, and lit again, which is what
 * the name claims. Obsidian fractures into edges rather than curves, so there is
 * no arc anywhere in the loop; the two lobes are hexagons and every edge is a
 * facet.
 *
 * The crossing is real. Both diagonals run straight through the centre vertex,
 * so the ribbon passes over itself the way a lemniscate does. That detail is
 * load-bearing rather than pedantic: an earlier version used square-on-point
 * lobes and masked the crossing away entirely, and it stopped reading as a loop:
 * it read as two diamonds with a star between them.
 *
 * ## The gradient
 *
 * The loop and the spark now run the same ramp the standalone files in
 * `public/brand/` always have: dim tail to hot head on the loop, a bright core
 * on the spark. `BrandGradientDefs` (`brand-gradients.tsx`) is what makes that
 * safe to do inline: its stops read CSS custom properties rather than literal
 * colours, so the ramp still follows the theme toggle and still collapses to
 * flat teal on the `/admin` surface (brand-theme.css §3b) with no variant logic
 * here, same contract flat `currentColor` used to give.
 *
 * The spark is not a second opacity of the loop's hot end, for the same reason
 * it never was: two opacities of one colour over a near-black field go muddy,
 * amber at 55% on `#0a0b0f` lands on brown. It is its own radial gradient, and
 * the mask clears a hairline of ground around it so the silhouette does the
 * separating.
 *
 * SVG rather than an image file so it is one paint with the rest of the header —
 * no second request, no flash of a differently-coloured logo, and it survives a
 * theme toggle without a `<picture>` element.
 *
 * The mask id is a fixed string rather than a generated one. `useId` is a hook
 * and this is a Server Component, and a fixed id is safe here on both counts:
 * one brand slot renders per page (the layouts are mutually exclusive), and were
 * two ever to render, every instance defines byte-identical mask content, so
 * resolving them all to the first is a no-op.
 *
 * Geometry comes from `@/components/brand/geometry`, which the hero mesh and the
 * small marketing diagrams also read: the paths used to be pasted here by hand,
 * which is how a logo ends up with two slightly different sparks in two places.
 * The source of truth for the shape itself is still
 * `scripts/framework/resparkable/build-brand.py`, which writes `public/brand/`.
 * Edit the script, then bring the change to the geometry module. Full reasoning:
 * `.context/framework/resparkable/brand-assets.md`.
 *
 * ## Why the mark is nudged down, and why the nudge is in `em`
 *
 * `items-center` centres the svg box against the *line box*, and for this
 * typeface that is not where the word looks like it is. Martian Mono declares an
 * ascent of a full 1.0em with no line gap (next/font's own fallback numbers give
 * it away: `ascent-override: 63.69%` × `size-adjust: 157.02%` = 1.000, descent
 * 0.200). An ascent that tall leaves a band of empty space above the letters
 * inside every line box, so centring on the line box centres on air and the mark
 * rides high. It is about 2px at header size, which is exactly enough to look
 * like a mistake.
 *
 * Working in units of this element's font-size, with the wordmark at 0.95em and
 * the line box at whatever the caller's line-height gives:
 *
 * ```
 * baseline      = (L - 1.2·w)/2 + 1.0·w  =  L/2 + 0.4·w
 * word ink mid  = baseline - (0.73·w + 0.2·w)/2  =  L/2 + 0.135·w
 * svg mid       = L/2                                (items-center)
 * ```
 *
 * So the correction is 0.135 × 0.95em ≈ **0.13em**, and `L` cancels out: the
 * same nudge is right at every size this lockup is used at, which is why it is
 * expressed in `em` and not in pixels. The svg's own ink is already centred in
 * its viewBox — loop plus its 4.6 stroke spans y 3.7→30.3 of 34, mid 17.0,
 * dead centre — so moving the box moves the optical centre with it.
 *
 * ## Why the mark is bigger than it was
 *
 * `0.92em` → `1.06em` (width follows the 64:34 viewBox). The mark's ink is 78%
 * of its box height, so at 0.92em it stood 0.72em tall next to a word with
 * 0.88em of ink, and read as the smaller of the two things in a lockup where
 * they should read as one. At 1.06em its ink is 0.83em and the two sit level.
 *
 * The wordmark's own reasoning lives in `spark-wordmark.tsx`.
 */

export function BrandMark({ className }: { className?: string }): React.ReactNode {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <svg
        viewBox="0 0 64 34"
        className="h-[1.06em] w-[1.99em] shrink-0 translate-y-[0.13em]"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <BrandGradientDefs />
        </defs>
        <mask id="resparkable-brand-mark-clear">
          <rect x="-10" y="-10" width="84" height="54" fill="#fff" />
          {/* Dilated by a 2.8-wide stroke: the clearance ring, not the spark. */}
          <path d={SPARK_PATH} fill="#000" stroke="#000" strokeWidth="2.8" strokeLinejoin="round" />
        </mask>
        <path
          d={LOOP_PATH}
          mask="url(#resparkable-brand-mark-clear)"
          fill="none"
          stroke={`url(#${BRAND_LOOP_GRADIENT_ID})`}
          strokeWidth="4.6"
          strokeMiterlimit="10"
        />
        <path d={SPARK_PATH} fill={`url(#${BRAND_SPARK_GRADIENT_ID})`} />
      </svg>
      <SparkWordmark className="text-[0.95em]" />
    </span>
  );
}
