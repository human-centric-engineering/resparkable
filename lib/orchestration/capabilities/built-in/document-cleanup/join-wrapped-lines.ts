import { z } from 'zod';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import {
  describeRefusal,
  MutationSummary,
  mutateCleanupContent,
} from '@/lib/orchestration/capabilities/built-in/document-cleanup/context';

// PDF text extraction emits one line per RENDERED line, not one per paragraph,
// so a sentence arrives hard-wrapped across four or five lines and a hyphenated
// word arrives split in two. Nothing else in the cleanup toolbox can put those
// back together: collapse_whitespace works within a line, strip_lines_matching
// tests each line separately (a \n pattern can never match), and strip_matches
// can only delete a match, never replace it with a space.

const schema = z
  .object({
    dehyphenate: z.boolean().optional(),
    onlyLowercaseContinuations: z.boolean().optional(),
  })
  .strict();

type Args = z.infer<typeof schema>;

interface Data extends MutationSummary {
  dehyphenate: boolean;
  onlyLowercaseContinuations: boolean;
  /** Hyphen-split words rejoined, e.g. "compre-\nhensive" → "comprehensive". */
  dehyphenated: number;
  /** Wrapped lines joined to the line above with a space. */
  joined: number;
  /**
   * Line numbers left alone because the break looks like a split WORD rather
   * than a wrapped sentence — joining them with a space would be as wrong as
   * leaving them. Surfaced so the agent can report them instead of implying
   * the document is now clean.
   */
  suspectedSplitWords: number[];
}

// A line the reflow must never absorb or append to: headings, list items,
// table rows and numbered sections are structure, not a wrapped sentence.
const STRUCTURAL = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|\[|`{3})/;

// Sentence-final punctuation. A line ending here is a finished thought, so the
// next line starts something new rather than continuing it.
const SENTENCE_END = /[.!?:;"”')\]]\s*$/;

// "compre-" at end of line: a hyphen preceded by a letter, at the very end.
const TRAILING_HYPHEN = /([A-Za-z])-$/;

// A continuation line that is nothing but a short lowercase fragment — "y"
// under "SurveyMonke". A renderer that wraps a SENTENCE does not leave one or
// two letters alone on a line; a table cell too narrow for its word does. The
// fragment belongs to the word above with NO space, but "no space" is wrong
// for every ordinary wrap, so this is left for a human or an LLM rewrite.
const SPLIT_WORD_FRAGMENT = /^[a-z]{1,3}$/;

/**
 * Rejoin lines that a fixed-width renderer wrapped mid-sentence.
 *
 * Deliberately conservative — it only joins when the evidence is strong, and
 * leaves anything ambiguous alone. A mid-WORD split with no hyphen
 * ("SurveyMonke" / "y", which PDF table cells produce) is not decidable from
 * the text: joining with a space and joining without one are both wrong
 * somewhere in the same document. Those are the cases to send to an LLM
 * rewrite, which is why this capability reports its counts rather than
 * claiming the document is now clean.
 */
export function joinWrappedLines(
  content: string,
  opts: { dehyphenate: boolean; onlyLowercaseContinuations: boolean }
): { next: string; dehyphenated: number; joined: number; suspectedSplitWords: number[] } {
  const lines = content.split('\n');
  const out: string[] = [];
  const suspectedSplitWords: number[] = [];
  let dehyphenated = 0;
  let joined = 0;

  for (const [index, raw] of lines.entries()) {
    const line = raw;
    const prev = out.length > 0 ? out[out.length - 1] : null;

    const canContinue =
      prev !== null &&
      prev.trim() !== '' && // blank line = paragraph break, always preserved
      line.trim() !== '' &&
      !STRUCTURAL.test(prev) &&
      !STRUCTURAL.test(line);

    if (canContinue) {
      const hyphen = opts.dehyphenate ? TRAILING_HYPHEN.exec(prev.trimEnd()) : null;
      if (hyphen) {
        // "compre-" + "hensive" → "comprehensive". Unambiguous: the hyphen is
        // the renderer's, not the author's, when the next line continues a word.
        out[out.length - 1] = `${prev.trimEnd().slice(0, -1)}${line.trimStart()}`;
        dehyphenated++;
        continue;
      }

      // A split word, not a wrapped sentence: report it and leave the break.
      if (SPLIT_WORD_FRAGMENT.test(line.trim()) && /[A-Za-z]$/.test(prev.trimEnd())) {
        // 1-based line number of the fragment itself.
        suspectedSplitWords.push(index + 1);
        out.push(line);
        continue;
      }

      const continues = !SENTENCE_END.test(prev);
      const lowercaseStart = /^\s*[a-z]/.test(line);
      if (continues && (!opts.onlyLowercaseContinuations || lowercaseStart)) {
        out[out.length - 1] = `${prev.trimEnd()} ${line.trimStart()}`;
        joined++;
        continue;
      }
    }

    out.push(line);
  }

  return { next: out.join('\n'), dehyphenated, joined, suspectedSplitWords };
}

export class JoinWrappedLinesCapability extends BaseCapability<Args, Data> {
  readonly slug = 'join_wrapped_lines';
  protected readonly schema = schema;

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'join_wrapped_lines',
    description:
      'Rejoin sentences that a PDF or fixed-width renderer wrapped across several lines, and rejoin hyphen-split words ("compre-" + "hensive"). THIS is the tool for "sentences broken mid-way by a newline" — collapse_whitespace does not join lines. Blank lines, headings, list items and table rows are left alone, and breaks that look like a split WORD rather than a wrapped sentence are reported in suspectedSplitWords rather than guessed at. Deterministic — does not consume LLM tokens.',
    parameters: {
      type: 'object',
      properties: {
        dehyphenate: {
          type: 'boolean',
          description: 'Rejoin a word split by a trailing hyphen at end of line. Default true.',
        },
        onlyLowercaseContinuations: {
          type: 'boolean',
          description:
            'Only join when the next line starts with a lowercase letter — the safe setting for documents whose headings are not markdown. Default true. Set false to also join lines that continue with a capitalised word (names, table cells).',
        },
      },
    },
  };

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const dehyphenate = args.dehyphenate ?? true;
    const onlyLowercaseContinuations = args.onlyLowercaseContinuations ?? true;

    const outcome = await mutateCleanupContent(
      context,
      { source: 'capability:join_wrapped_lines', actorId: context.userId },
      (content) => {
        const result = joinWrappedLines(content, { dehyphenate, onlyLowercaseContinuations });
        return {
          next: result.next,
          data: {
            dehyphenate,
            onlyLowercaseContinuations,
            dehyphenated: result.dehyphenated,
            joined: result.joined,
            suspectedSplitWords: result.suspectedSplitWords,
          },
        };
      }
    );
    if (!outcome.ok) {
      const refusal = describeRefusal(outcome);
      return this.error(refusal.message, refusal.code);
    }
    return this.success({ ...outcome.data, ...outcome.summary });
  }
}
