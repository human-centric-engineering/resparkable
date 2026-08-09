import { cn } from '@/lib/utils';
import {
  LOOP_PATH,
  SPARK_PATH,
  LOOP_NODES,
  LAP_SECONDS,
  nodeDelay,
  sparkStyle,
  TRACED_SPARK_TRANSFORM,
  TRACED_SPARK_CLEARANCE,
} from '@/components/brand/geometry';
import {
  BrandGradientDefs,
  BRAND_LOOP_GRADIENT_ID,
  BRAND_SPARK_GRADIENT_ID,
} from '@/components/brand/brand-gradients';

/**
 * SparkGlyph — the mark on its own, at whatever size the caller wants.
 *
 * **Fork-owned.** `BrandMark` is the header lockup and is sized in `em` so it
 * rides the text beside it; this is the same geometry with no wordmark, no
 * intrinsic size and no opinion about what it sits next to. Public pages use it
 * as a section divider, above the closing call to action, and in the footer.
 *
 * `traced` adds the pulse and the vertices — the same treatment `SparkMesh`
 * gives the loop, minus the surrounding field. Use it at 40px and up. Below
 * that the vertices land on top of each other and it reads as a smudge; the
 * plain glyph holds down to about 24px, and `public/brand/resparkable-icon.svg`
 * is what survives 16.
 *
 * The loop, the trace and the crossing spark all draw from `BrandGradientDefs`
 * (same as `BrandMark`), so the ramp follows the theme toggle and the `/admin`
 * swap with no variant logic here. That means a caller can no longer dim the
 * glyph with a `text-primary/NN` colour-opacity modifier, since colour no
 * longer drives the fill: use `opacity-[NN%]` on the glyph itself instead. The
 * travelling pulse and the vertex dots stay on the loop gradient too, so the
 * highlight visibly warms as it crosses the ramp rather than just fading in.
 */
export function SparkGlyph({
  className,
  traced = false,
  title,
}: {
  className?: string;
  /** Draw the vertices and the travelling pulse. 40px and up only. */
  traced?: boolean;
  /** Give it an accessible name. Omitted, it is decorative and hidden. */
  title?: string;
}): React.ReactNode {
  return (
    <svg
      viewBox="0 0 64 34"
      className={cn('shrink-0', className)}
      style={sparkStyle({ '--spark-lap': `${LAP_SECONDS}s` })}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : 'true'}
      aria-label={title}
      focusable="false"
    >
      <defs>
        <BrandGradientDefs />
      </defs>

      <mask id="spark-glyph-clear">
        <rect x="-10" y="-10" width="84" height="54" fill="#fff" />
        {/* Dilated by a stroke: the clearance ring, not the spark. Both the
            spark and its ring shrink in `traced` mode — see the reasoning on
            `TRACED_SPARK_TRANSFORM`. */}
        <path
          d={SPARK_PATH}
          transform={traced ? TRACED_SPARK_TRANSFORM : undefined}
          fill="#000"
          stroke="#000"
          strokeWidth={traced ? TRACED_SPARK_CLEARANCE : 2.8}
          strokeLinejoin="round"
        />
      </mask>

      <path
        d={LOOP_PATH}
        mask="url(#spark-glyph-clear)"
        fill="none"
        stroke={`url(#${BRAND_LOOP_GRADIENT_ID})`}
        strokeWidth={traced ? 1.6 : 4.6}
        strokeMiterlimit="10"
        opacity={traced ? 0.24 : 1}
      />

      {traced ? (
        <>
          <path
            d={LOOP_PATH}
            pathLength="100"
            mask="url(#spark-glyph-clear)"
            fill="none"
            stroke={`url(#${BRAND_LOOP_GRADIENT_ID})`}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeMiterlimit="10"
            className="spark-trace"
          />
          <g fill={`url(#${BRAND_LOOP_GRADIENT_ID})`}>
            {LOOP_NODES.filter((node) => !node.crossing).map((node) => (
              <circle
                key={`${node.x},${node.y}`}
                cx={node.x}
                cy={node.y}
                r="1.2"
                className="spark-node"
                style={sparkStyle({ '--spark-phase': nodeDelay(node.phase) })}
              />
            ))}
          </g>
        </>
      ) : null}

      {/* The positioning transform sits on the wrapper: a CSS `transform` in
          the keyframes replaces an element's transform attribute rather than
          composing with it. */}
      <g transform={traced ? TRACED_SPARK_TRANSFORM : undefined}>
        <path
          d={SPARK_PATH}
          fill={`url(#${BRAND_SPARK_GRADIENT_ID})`}
          className={traced ? 'spark-core' : undefined}
          style={traced ? sparkStyle({ '--spark-phase': nodeDelay(0) }) : undefined}
        />
      </g>
    </svg>
  );
}

/**
 * A section rule with the mark set into it.
 *
 * The public pages separate sections with a single hairline, because banding
 * them would cover `.obsidian-field`'s grid — the alignment reference every
 * column is set against. This keeps the hairline and interrupts it once, which
 * is as much brand as a divider can carry before it becomes a graphic in its
 * own right and starts asking to be read.
 */
export function SparkRule({ className }: { className?: string }): React.ReactNode {
  return (
    <div className={cn('flex items-center gap-4', className)} aria-hidden="true">
      <span className="bg-border/70 h-px flex-1" />
      <SparkGlyph className="h-[14px] w-[26px] opacity-45" />
      <span className="bg-border/70 h-px flex-1" />
    </div>
  );
}
