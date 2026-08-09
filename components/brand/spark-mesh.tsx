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
 * SparkMesh — the mark, read as the graph it already is, inside a wider field.
 *
 * **Fork-owned.** The public pages' one piece of artwork.
 *
 * ## Why this and not an illustration
 *
 * The landing hero used to have a mocked-up capture panel, and it went because a
 * diagram of the product is not the product. This is not a diagram of the
 * product either — it is the logo, drawn at a size where you can see what it is
 * made of. Eleven vertices, twelve straight facets, and a pulse that laps them.
 * Nothing here claims a feature.
 *
 * The wider mesh is the part that carries the argument. The loop is not floating
 * in a void; it is one knot in a field of other nodes, and three of those far
 * nodes catch light shortly after the spark crosses the centre — while the
 * crossing itself does not dim to pay for it. That is the only thing the page
 * needs a picture for, and it is not a thing a sentence does well.
 *
 * ## Why it is CSS and not a canvas
 *
 * Every moving part is `opacity`, `transform` or `stroke-dashoffset`, which the
 * compositor handles without touching layout or paint. There is no rAF loop, no
 * client bundle and no hydration — this is a Server Component that ships as
 * markup. A `<canvas>` particle field would cost all four and look worse, since
 * the geometry here is exact rather than random.
 *
 * The timing lives in `geometry.ts` beside the vertex table that computes it:
 * facet lengths differ, so evenly-spaced flashes drift visibly out of step with
 * the pulse by the far lobe. `--spark-lap` and `--spark-phase` carry the numbers
 * into the classes in `brand-theme.css`.
 *
 * ## Colour
 *
 * The loop, the travelling trace and the crossing spark draw from
 * `BrandGradientDefs`, the same ramp `BrandMark` and `SparkGlyph` use, so the
 * mark itself carries the same dim-tail-to-hot-head nuance everywhere it
 * appears. The field lines and the far motes stay flat and dim on
 * `currentColor`: they are ambient context for the mark, not the mark, and
 * giving them the same ramp would compete with it instead of setting it off.
 *
 * ## Ids
 *
 * Fixed, not `useId`. Two instances can appear on one page (hero and footer
 * band); every instance emits byte-identical `<mask>` content, so a browser
 * resolving all references to the first is a no-op. `useId` is also a hook, and
 * this deliberately is not a client component. Same reasoning covers the
 * gradient defs.
 */

/**
 * Far nodes. Not on the loop — the field the loop sits in.
 *
 * `kind: 'mote'` breathes on its own long cycle, unrelated to the pulse: the
 * field is not something the loop drives. `kind: 'relay'` is the exception —
 * three nodes that catch shortly after the spark crosses the centre, and
 * `phase` for those is a lap fraction rather than a mote offset.
 */
interface Mote {
  id: string;
  x: number;
  y: number;
  r: number;
  kind: 'mote' | 'relay';
  /** Lap fraction for a relay; seconds-offset divisor for a mote. */
  phase: number;
}

const MOTES: readonly Mote[] = [
  { id: 'a', x: 16, y: 22, r: 1.5, kind: 'mote', phase: 0.11 },
  { id: 'b', x: 44, y: 10, r: 1.2, kind: 'mote', phase: 0.62 },
  { id: 'c', x: 84, y: 8, r: 1.9, kind: 'relay', phase: 0.05 },
  { id: 'd', x: 124, y: 16, r: 1.3, kind: 'mote', phase: 0.29 },
  { id: 'e', x: 152, y: 34, r: 1.6, kind: 'mote', phase: 0.74 },
  { id: 'f', x: 160, y: 66, r: 1.2, kind: 'mote', phase: 0.4 },
  { id: 'g', x: 132, y: 92, r: 1.7, kind: 'mote', phase: 0.86 },
  { id: 'h', x: 92, y: 98, r: 1.3, kind: 'mote', phase: 0.19 },
  { id: 'i', x: 56, y: 94, r: 1.5, kind: 'mote', phase: 0.67 },
  { id: 'j', x: 22, y: 78, r: 1.9, kind: 'relay', phase: 0.55 },
  { id: 'k', x: 6, y: 50, r: 1.4, kind: 'mote', phase: 0.48 },
  { id: 'l', x: 34, y: 40, r: 1.2, kind: 'mote', phase: 0.93 },
  { id: 'm', x: 134, y: 54, r: 1.9, kind: 'relay', phase: 0.6 },
  { id: 'n', x: 44, y: 70, r: 1.3, kind: 'mote', phase: 0.35 },
];

/** The motes' own breathe cycle. Deliberately not a factor of the lap. */
const MOTE_SECONDS = 9;

/**
 * Mesh edges, viewBox coordinates. Spokes reach in to a loop vertex; the rest
 * chain the far nodes to each other, so the loop reads as *in* something rather
 * than as the centre of a starburst.
 */
const MESH_EDGES: readonly [number, number, number, number][] = [
  // spokes, far node → loop vertex
  [6, 50, 56, 52],
  [34, 40, 64, 41],
  [44, 10, 75, 41],
  [84, 8, 75, 41],
  [84, 8, 93, 41],
  [124, 16, 104, 41],
  [152, 34, 112, 52],
  [134, 54, 112, 52],
  [132, 92, 104, 63],
  [92, 98, 93, 63],
  [56, 94, 64, 63],
  [44, 70, 64, 63],
  [44, 70, 75, 63],
  [22, 78, 56, 52],
  // the field's own chords
  [16, 22, 6, 50],
  [16, 22, 44, 10],
  [44, 10, 84, 8],
  [84, 8, 124, 16],
  [124, 16, 152, 34],
  [152, 34, 160, 66],
  [160, 66, 134, 54],
  [160, 66, 132, 92],
  [132, 92, 92, 98],
  [92, 98, 56, 94],
  [56, 94, 22, 78],
  [22, 78, 6, 50],
  [44, 10, 34, 40],
];

/** Puts the 64×34 mark at the centre of the 168×104 field. */
const LOOP_OFFSET = 'translate(52 35)';

export function SparkMesh({ className }: { className?: string }): React.ReactNode {
  const lap = sparkStyle({ '--spark-lap': `${LAP_SECONDS}s` });

  return (
    <svg
      viewBox="0 0 168 104"
      className={cn('text-primary w-full', className)}
      style={lap}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <BrandGradientDefs />
        {/* Dilated by a 2.8-wide stroke: this is the clearance ring around the
            spark, not the spark. Two opacities of one colour over near-black go
            muddy, so the silhouette does the separating instead. */}
        <mask id="spark-mesh-clear">
          <rect x="-20" y="-20" width="208" height="144" fill="#fff" />
          <g transform={LOOP_OFFSET}>
            <path
              d={SPARK_PATH}
              transform={TRACED_SPARK_TRANSFORM}
              fill="#000"
              stroke="#000"
              strokeWidth={TRACED_SPARK_CLEARANCE}
              strokeLinejoin="round"
            />
          </g>
        </mask>
      </defs>

      {/* The field. Hairlines at 10% — present, unnameable, which is the same
          contract `.obsidian-field`'s grid runs on. */}
      <g stroke="currentColor" strokeWidth="0.4" opacity="0.1">
        {MESH_EDGES.map(([x1, y1, x2, y2]) => (
          <line key={`${x1},${y1},${x2},${y2}`} x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
      </g>

      <g fill="currentColor">
        {MOTES.map((mote) => (
          <circle
            key={mote.id}
            cx={mote.x}
            cy={mote.y}
            r={mote.r}
            className={mote.kind === 'relay' ? 'spark-relay' : 'spark-mote'}
            style={sparkStyle({
              '--spark-phase':
                mote.kind === 'relay'
                  ? nodeDelay(mote.phase)
                  : `${(-mote.phase * MOTE_SECONDS).toFixed(2)}s`,
            })}
          />
        ))}
      </g>

      <g transform={LOOP_OFFSET}>
        {/* The structure: the loop as a standing thing, dim. */}
        <path
          d={LOOP_PATH}
          mask="url(#spark-mesh-clear)"
          fill="none"
          stroke={`url(#${BRAND_LOOP_GRADIENT_ID})`}
          strokeWidth="1.5"
          strokeMiterlimit="10"
          opacity="0.22"
        />

        {/* The traveller. Same path, bright, 14% of the lap visible at a time. */}
        <path
          d={LOOP_PATH}
          pathLength="100"
          mask="url(#spark-mesh-clear)"
          fill="none"
          stroke={`url(#${BRAND_LOOP_GRADIENT_ID})`}
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeMiterlimit="10"
          className="spark-trace"
        />

        {/* Vertices. The crossing is drawn by the spark below, not here. */}
        <g fill={`url(#${BRAND_LOOP_GRADIENT_ID})`}>
          {LOOP_NODES.filter((node) => !node.crossing).map((node) => (
            <circle
              key={`${node.x},${node.y}`}
              cx={node.x}
              cy={node.y}
              r="1.15"
              className="spark-node"
              style={sparkStyle({ '--spark-phase': nodeDelay(node.phase) })}
            />
          ))}
        </g>

        {/* The positioning transform sits on a wrapper, not on the path. A CSS
            `transform` in the keyframes replaces an element's own transform
            attribute rather than composing with it, so animating the path
            directly would throw away the scale that sizes it. */}
        <g transform={TRACED_SPARK_TRANSFORM}>
          <path
            d={SPARK_PATH}
            fill={`url(#${BRAND_SPARK_GRADIENT_ID})`}
            className="spark-core"
            style={sparkStyle({ '--spark-phase': nodeDelay(0) })}
          />
        </g>
      </g>
    </svg>
  );
}
