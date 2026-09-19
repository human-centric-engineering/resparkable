'use client';

// Line-oriented text diff renderer for the Document Clean Up surface: the
// Original-vs-Cleaned tab, the revision history, and the pending-LLM-change
// card. No external library — the codebase has no `diff` package and LCS-based
// unified diff is small enough to inline. Modelled on the JSON diff component
// at workflows/version-diff-viewer.tsx.
//
// Reads like a GitHub file diff: line numbers down each gutter, changed lines
// highlighted, and long unchanged runs collapsed behind an expander so a
// five-line change in a 600-line document is actually findable. `mode`
// switches between the unified and side-by-side presentations.

import { useMemo, useState } from 'react';
import { ChevronsUpDown, Columns2, Rows3 } from 'lucide-react';

export type DiffMode = 'unified' | 'split';

interface TextDiffViewerProps {
  before: string;
  after: string;
  /** 'unified' (default) stacks removals and additions; 'split' shows two columns. */
  mode?: DiffMode;
  /** Unchanged lines kept either side of a change before collapsing. Default 3. */
  contextLines?: number;
  /** Column headings in split mode. */
  beforeLabel?: string;
  afterLabel?: string;
  /** Height cap for the scroll area. Default `max-h-[60vh]`. */
  maxHeightClass?: string;
}

type OpType = 'equal' | 'add' | 'del';

interface Op {
  type: OpType;
  line: string;
  /** 1-based line number in `before` (absent for additions). */
  aLine?: number;
  /** 1-based line number in `after` (absent for removals). */
  bLine?: number;
}

// Cap on the changed span each side may contribute to the LCS table. The
// table is (m+1)·(n+1) numbers, so an uncapped whole-document diff on a
// cleanup-sized doc (up to ~100k tokens ≈ 5–10k lines) allocates tens of
// millions of slots and hangs or OOMs the tab. Past this we say so instead.
const MAX_DIFF_LINES = 1_500;

// Classic LCS-based line diff, bounded. Returns null when the changed span
// is too large to diff inline — the caller renders a notice instead.
function diffLines(before: string, after: string): Op[] | null {
  const a = before.split('\n');
  const b = after.split('\n');

  // Identical input: the revision history deliberately passes the same string
  // on both sides to preview a version, and there is no point building a table
  // to discover every line is unchanged.
  if (before === after) {
    return a.map((line, i): Op => ({ type: 'equal', line, aLine: i + 1, bLine: i + 1 }));
  }

  // Trim the common prefix and suffix before building the table. A section
  // rewrite changes a handful of lines in an otherwise untouched document,
  // so this collapses a whole-document table into one over the changed span.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length > MAX_DIFF_LINES || midB.length > MAX_DIFF_LINES) return null;

  const m = midA.length;
  const n = midB.length;

  // LCS table over the changed span only
  const lcs: number[][] = Array.from({ length: m + 1 }, (): number[] =>
    new Array<number>(n + 1).fill(0)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      lcs[i][j] =
        midA[i - 1] === midB[j - 1]
          ? lcs[i - 1][j - 1] + 1
          : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
    }
  }

  // Backtrack to produce ops over the changed span, carrying the line numbers
  // each op occupies in its own side.
  const mid: Op[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (midA[i - 1] === midB[j - 1]) {
      mid.unshift({
        type: 'equal',
        line: midA[i - 1],
        aLine: start + i,
        bLine: start + j,
      });
      i--;
      j--;
    } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
      mid.unshift({ type: 'del', line: midA[i - 1], aLine: start + i });
      i--;
    } else {
      mid.unshift({ type: 'add', line: midB[j - 1], bLine: start + j });
      j--;
    }
  }
  while (i > 0) {
    mid.unshift({ type: 'del', line: midA[i - 1], aLine: start + i });
    i--;
  }
  while (j > 0) {
    mid.unshift({ type: 'add', line: midB[j - 1], bLine: start + j });
    j--;
  }

  // Re-attach the untouched prefix / suffix as equal context.
  const ops: Op[] = [];
  for (let k = 0; k < start; k++) {
    ops.push({ type: 'equal', line: a[k], aLine: k + 1, bLine: k + 1 });
  }
  ops.push(...mid);
  for (let k = endA; k < a.length; k++) {
    ops.push({ type: 'equal', line: a[k], aLine: k + 1, bLine: k + 1 + (endB - endA) });
  }
  return ops;
}

/** One rendered unit: either a run of rows, or a collapsed run of unchanged rows. */
type Segment<Row> = { kind: 'rows'; rows: Row[] } | { kind: 'gap'; rows: Row[] };

/**
 * Split a row list into visible runs and collapsible unchanged gaps. Rows are
 * classified by `isEqual` so the same routine serves both presentations.
 */
function segmentRows<Row>(
  rows: Row[],
  isEqual: (row: Row) => boolean,
  contextLines: number
): Segment<Row>[] {
  const segments: Segment<Row>[] = [];
  let index = 0;

  while (index < rows.length) {
    if (!isEqual(rows[index])) {
      const startOfChange = index;
      while (index < rows.length && !isEqual(rows[index])) index++;
      segments.push({ kind: 'rows', rows: rows.slice(startOfChange, index) });
      continue;
    }

    const startOfRun = index;
    while (index < rows.length && isEqual(rows[index])) index++;
    const run = rows.slice(startOfRun, index);
    // A run at the very start or end has context on one side only.
    const leadingContext = startOfRun === 0 ? 0 : contextLines;
    const trailingContext = index === rows.length ? 0 : contextLines;

    // Collapsing is only worth a row if it hides more than the expander costs:
    // the context kept either side, plus the expander's own line.
    if (run.length <= leadingContext + trailingContext + 1) {
      segments.push({ kind: 'rows', rows: run });
      continue;
    }
    if (leadingContext > 0) segments.push({ kind: 'rows', rows: run.slice(0, leadingContext) });
    segments.push({
      kind: 'gap',
      rows: run.slice(leadingContext, run.length - trailingContext),
    });
    if (trailingContext > 0) {
      segments.push({ kind: 'rows', rows: run.slice(run.length - trailingContext) });
    }
  }
  return segments;
}

const ROW_TONE: Record<OpType, string> = {
  add: 'bg-emerald-100/60 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200',
  del: 'bg-red-100/60 text-red-900 dark:bg-red-900/30 dark:text-red-200',
  equal: 'text-muted-foreground',
};

function GutterNumber({ value }: { value?: number }) {
  return (
    <span className="text-muted-foreground/60 w-10 shrink-0 pr-2 text-right tabular-nums select-none">
      {value ?? ''}
    </span>
  );
}

function GapRow({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      data-testid="diff-gap"
      className="text-muted-foreground hover:bg-muted/60 hover:text-foreground flex w-full items-center gap-1.5 border-y px-2 py-1 text-left text-[11px]"
    >
      <ChevronsUpDown className="h-3 w-3 shrink-0" aria-hidden="true" />
      {count.toLocaleString()} unchanged {count === 1 ? 'line' : 'lines'}
    </button>
  );
}

/** Side-by-side row: at most one op per side, aligned. */
interface SplitRow {
  left?: Op;
  right?: Op;
}

/**
 * Pair removals with additions so a replaced line sits opposite its
 * replacement. Consecutive del/add runs are zipped positionally, which is what
 * GitHub's split view does.
 */
function toSplitRows(ops: Op[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index].type === 'equal') {
      rows.push({ left: ops[index], right: ops[index] });
      index++;
      continue;
    }
    const dels: Op[] = [];
    const adds: Op[] = [];
    while (index < ops.length && ops[index].type !== 'equal') {
      if (ops[index].type === 'del') dels.push(ops[index]);
      else adds.push(ops[index]);
      index++;
    }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({ left: dels[k], right: adds[k] });
    }
  }
  return rows;
}

export function TextDiffViewer({
  before,
  after,
  mode = 'unified',
  contextLines = 3,
  beforeLabel = 'Original',
  afterLabel = 'Cleaned',
  maxHeightClass = 'max-h-[60vh]',
}: TextDiffViewerProps) {
  const ops = useMemo(() => diffLines(before, after), [before, after]);
  const [expandedGaps, setExpandedGaps] = useState<Set<number>>(() => new Set());

  const segments = useMemo(() => {
    if (ops === null) return [];
    return mode === 'split'
      ? segmentRows(toSplitRows(ops), (r) => r.left?.type === 'equal', contextLines)
      : segmentRows(ops, (op) => op.type === 'equal', contextLines);
  }, [ops, mode, contextLines]);

  if (ops === null) {
    const beforeLines = before.split('\n').length;
    const afterLines = after.split('\n').length;
    return (
      <div className="bg-muted/20 text-muted-foreground rounded-md border p-3 text-xs">
        <p className="text-foreground font-medium">Too much changed to diff inline.</p>
        <p className="mt-1">
          {beforeLines.toLocaleString()} lines before, {afterLines.toLocaleString()} after — more
          than {MAX_DIFF_LINES.toLocaleString()} changed lines on one side. Accept or reject on the
          instructions above, or refine section by section so each change stays reviewable.
        </p>
      </div>
    );
  }

  const added = ops.filter((op) => op.type === 'add').length;
  const removed = ops.filter((op) => op.type === 'del').length;
  const expand = (key: number) =>
    setExpandedGaps((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });

  let gapKey = 0;

  return (
    <div className="space-y-1">
      <div className="text-muted-foreground flex items-center gap-3 text-[11px]">
        {mode === 'split' ? (
          <Columns2 className="h-3 w-3" aria-hidden="true" />
        ) : (
          <Rows3 className="h-3 w-3" aria-hidden="true" />
        )}
        <span className="text-emerald-700 dark:text-emerald-300">
          +{added.toLocaleString()} added
        </span>
        <span className="text-red-700 dark:text-red-300">−{removed.toLocaleString()} removed</span>
        {added === 0 && removed === 0 ? <span>no differences</span> : null}
      </div>

      <div
        className={`bg-muted/20 overflow-auto rounded-md border font-mono text-xs leading-relaxed ${maxHeightClass}`}
      >
        {mode === 'split' ? (
          <div className="bg-muted/40 text-muted-foreground sticky top-0 z-10 grid grid-cols-2 border-b text-[11px] font-medium">
            <span className="border-r px-2 py-1">{beforeLabel}</span>
            <span className="px-2 py-1">{afterLabel}</span>
          </div>
        ) : null}

        {segments.map((segment, segmentIndex) => {
          if (segment.kind === 'gap') {
            const key = gapKey++;
            if (!expandedGaps.has(key)) {
              return (
                <GapRow
                  key={`gap-${segmentIndex}`}
                  count={segment.rows.length}
                  onExpand={() => expand(key)}
                />
              );
            }
          }
          return (
            <div key={`seg-${segmentIndex}`}>
              {mode === 'split'
                ? (segment.rows as SplitRow[]).map((row, rowIndex) => (
                    <div key={rowIndex} className="grid grid-cols-2">
                      <SplitHalf op={row.left} side="left" />
                      <SplitHalf op={row.right} side="right" />
                    </div>
                  ))
                : (segment.rows as Op[]).map((op, rowIndex) => (
                    <div
                      key={rowIndex}
                      data-testid="diff-row"
                      data-diff-type={op.type}
                      className={`flex ${ROW_TONE[op.type]}`}
                    >
                      <GutterNumber value={op.aLine} />
                      <GutterNumber value={op.bLine} />
                      <span className="w-4 shrink-0 select-none">
                        {op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' '}
                      </span>
                      <span className="flex-1 pr-2 whitespace-pre-wrap">{op.line || ' '}</span>
                    </div>
                  ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Unified / side-by-side switch. Lives here so every diff surface offers the
 * same control in the same wording.
 */
export function DiffModeToggle({
  mode,
  onChange,
}: {
  mode: DiffMode;
  onChange: (mode: DiffMode) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-md border p-0.5">
      {(['unified', 'split'] as const).map((value) => {
        const Icon = value === 'unified' ? Rows3 : Columns2;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => onChange(value)}
            className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] capitalize transition ${
              mode === value
                ? 'bg-muted text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-3 w-3" aria-hidden="true" />
            {value}
          </button>
        );
      })}
    </div>
  );
}

function SplitHalf({ op, side }: { op?: Op; side: 'left' | 'right' }) {
  const border = side === 'left' ? 'border-r' : '';
  if (!op) {
    // No counterpart on this side — a striped filler keeps the two columns in
    // step so a replacement reads as one row, not two unrelated ones.
    return (
      <div
        data-testid="diff-half"
        data-diff-type="filler"
        className={`bg-muted/30 min-h-[1.5rem] ${border}`}
      />
    );
  }
  return (
    <div
      data-testid="diff-half"
      data-diff-type={op.type}
      className={`flex ${border} ${ROW_TONE[op.type]}`}
    >
      <GutterNumber value={side === 'left' ? op.aLine : op.bLine} />
      <span className="flex-1 pr-2 whitespace-pre-wrap">{op.line || ' '}</span>
    </div>
  );
}
