import { z } from 'zod';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { resolveCleanupTarget } from '@/lib/orchestration/capabilities/built-in/document-cleanup/context';

// A cleanup document can be ~100k tokens; a window has to be bounded or one
// call blows the model's context and the turn fails. These are the caps, not
// suggestions — an over-wide request is clamped and the response says so.
const DEFAULT_LINES = 60;
const MAX_LINES = 400;
const MAX_CHARS = 20_000;

const schema = z
  .object({
    fromLine: z.number().int().min(1).optional(),
    lineCount: z.number().int().min(1).optional(),
    which: z.enum(['current', 'original']).optional(),
  })
  .strict();

type Args = z.infer<typeof schema>;

interface Data {
  which: 'current' | 'original';
  fromLine: number;
  toLine: number;
  totalLines: number;
  /** Requested window was clamped to the caps above. */
  truncated: boolean;
  /** Lines prefixed with their 1-based number, so the agent can cite them. */
  text: string;
}

export class ReadDocumentCapability extends BaseCapability<Args, Data> {
  readonly slug = 'read_document';
  protected readonly schema = schema;

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'read_document',
    description:
      'Read a window of the document being cleaned, as numbered lines. Use this BEFORE choosing a transform, and again afterwards to verify the change actually landed — every other cleanup tool reports counts, not content, so this is the only way to see the text. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        fromLine: {
          type: 'number',
          description: '1-based first line to return. Default 1.',
        },
        lineCount: {
          type: 'number',
          description: `How many lines to return. Default ${DEFAULT_LINES}, maximum ${MAX_LINES}.`,
        },
        which: {
          type: 'string',
          enum: ['current', 'original'],
          description:
            '"current" = the working (cleaned) state, the default. "original" = the untouched parsed text, for comparing against what a transform did.',
        },
      },
    },
  };

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const target = await resolveCleanupTarget(context);
    if (!target) return this.error('Not in a Document Clean Up session.', 'not_cleanup_session');

    const which = args.which ?? 'current';
    const source = which === 'original' ? target.originalContent : target.content;
    const lines = source.split('\n');

    const fromLine = Math.min(Math.max(args.fromLine ?? 1, 1), Math.max(lines.length, 1));
    const requested = args.lineCount ?? DEFAULT_LINES;
    const lineCount = Math.min(requested, MAX_LINES);
    const endExclusive = Math.min(fromLine - 1 + lineCount, lines.length);

    const window = lines.slice(fromLine - 1, endExclusive);
    let text = window.map((line, i) => `${fromLine + i}: ${line}`).join('\n');
    let charTruncated = false;
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS);
      charTruncated = true;
    }

    return this.success({
      which,
      fromLine,
      toLine: endExclusive,
      totalLines: lines.length,
      truncated: charTruncated || requested > MAX_LINES || endExclusive < fromLine - 1 + lineCount,
      text,
    });
  }
}
