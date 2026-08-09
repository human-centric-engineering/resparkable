import { SparkGlyph } from '@/components/brand/spark-glyph';
import { SPARK_PATH, sparkStyle } from '@/components/brand/geometry';
import { cn } from '@/lib/utils';

/**
 * VerbDiagram — three small drawings for "catch it, kindle it, ignite others".
 *
 * **Fork-owned.** Built from the mark's own vocabulary and nothing else: straight
 * edges, round nodes, the four-point spark. No icon set, because a row of
 * generic glyphs beside three headings is the tell of a page with nothing to
 * say, and because the one thing these have to communicate is not in any icon
 * set anyway.
 *
 * Each drawing is one sentence:
 *
 * | Kind     | What it draws                                                        |
 * | -------- | -------------------------------------------------------------------- |
 * | `catch`  | Far nodes, breathing; three lines land and the spark is lit.          |
 * | `kindle` | The mark itself, pulse going round, crossing lighting twice a lap.    |
 * | `ignite` | The spark, edges out, three nodes catching, and the source undimmed.  |
 *
 * The last one is the argument. `catch` and `ignite` are deliberate inverses:
 * many dim into one lit, then one lit into many lit, with the source drawn at
 * exactly the same value in both. Nothing is subtracted by lighting someone
 * else up, and the drawing has to hold that or the copy beside it is only an
 * assertion.
 *
 * ## Scale
 *
 * These render at 1.6× their viewBox, which is what the radii and the spark
 * scale are set against. Drawn at 1:1 the nodes land at one and a half physical
 * pixels and disappear, and the spark — 21 units across in a 44-unit box —
 * takes half the drawing and turns three diagrams into three stars. Both numbers
 * are wrong at any other size, so change the frame and you must re-check them.
 *
 * `sparkAt` places the spark's crossing (32,17 in the mark's own space) at a
 * point and scales it, rather than re-deriving a second spark path at a
 * different origin. Order matters — translate, scale, then translate back.
 */

/** Put the spark's crossing at (cx, cy), at `scale`. */
function sparkAt(cx: number, cy: number, scale: number): string {
  return `translate(${cx} ${cy}) scale(${scale}) translate(-32 -17)`;
}

const SPARK_SCALE = 0.62;

/** Far nodes for `catch`: where it came from, which is nobody's business. */
const ORIGINS: readonly [number, number, number, number][] = [
  // x, y, r, breathe offset in seconds
  [5, 6, 2.4, 0],
  [3, 22, 3, -3.4],
  [9, 39, 2, -6.1],
];

/** Receivers for `ignite`. Same radii as the origins, lit exactly as brightly. */
const RECEIVERS: readonly [number, number, number, number][] = [
  [62, 7, 3, -1.2],
  [72, 23, 2.4, -4.6],
  [59, 38, 3, -7.3],
];

/** Where the lit spark sits in each drawing. */
const CAUGHT: [number, number] = [56, 22];
const SOURCE: [number, number] = [20, 22];

function mote(x: number, y: number, r: number, offset: number): React.ReactNode {
  return (
    <circle
      key={`${x},${y}`}
      cx={x}
      cy={y}
      r={r}
      fill="currentColor"
      className="spark-mote"
      style={sparkStyle({ '--spark-phase': `${offset}s` })}
    />
  );
}

export function VerbDiagram({
  kind,
  className,
}: {
  kind: 'catch' | 'kindle' | 'ignite';
  className?: string;
}): React.ReactNode {
  const frame = cn('text-primary flex h-[70px] w-32 items-center', className);

  if (kind === 'kindle') {
    return (
      <div className={frame}>
        <SparkGlyph traced className="w-full" />
      </div>
    );
  }

  const [cx, cy] = kind === 'catch' ? CAUGHT : SOURCE;

  return (
    <div className={frame}>
      <svg viewBox="0 0 80 44" className="w-full" aria-hidden="true" focusable="false">
        <g stroke="currentColor" strokeWidth="0.9" opacity="0.3">
          {(kind === 'catch' ? ORIGINS : RECEIVERS).map(([x, y]) => (
            <line key={`${x},${y}`} x1={x} y1={y} x2={cx} y2={cy} />
          ))}
        </g>

        {(kind === 'catch' ? ORIGINS : RECEIVERS).map(([x, y, r, offset]) => mote(x, y, r, offset))}

        <g transform={sparkAt(cx, cy, SPARK_SCALE)}>
          <path d={SPARK_PATH} fill="currentColor" />
        </g>
      </svg>
    </div>
  );
}
