import { z } from 'zod';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import {
  compileSafeRegex,
  resolveCleanupTarget,
} from '@/lib/orchestration/capabilities/built-in/document-cleanup/context';

const DEFAULT_MAX_MATCHES = 20;
const MAX_MATCHES = 100;
// Long lines (a whole PDF table flattened onto one) would otherwise dominate
// the response. Matched lines are elided around the match itself.
const MAX_LINE_CHARS = 300;

const schema = z
  .object({
    regex: z.string().min(1),
    flags: z.string().optional(),
    maxMatches: z.number().int().min(1).optional(),
  })
  .strict();

type Args = z.infer<typeof schema>;

interface Match {
  line: number;
  text: string;
}

interface Data {
  pattern: string;
  matchCount: number;
  /** True when more lines matched than `maxMatches` returned. */
  truncated: boolean;
  matches: Match[];
}

export class FindInDocumentCapability extends BaseCapability<Args, Data> {
  readonly slug = 'find_in_document';
  protected readonly schema = schema;

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'find_in_document',
    description:
      'Find lines in the document matching a regex, returning their line numbers and text. Use it to CHECK a pattern before running a destructive transform with it, and to count how many places a problem occurs. Read-only — it never modifies the document.',
    parameters: {
      type: 'object',
      properties: {
        regex: {
          type: 'string',
          description:
            'Regex pattern (no surrounding slashes). Matched against each line individually, so a pattern containing \\n never matches — use read_document to inspect line breaks.',
        },
        flags: { type: 'string', description: 'Optional regex flags, e.g. "i".' },
        maxMatches: {
          type: 'number',
          description: `Maximum matching lines to return. Default ${DEFAULT_MAX_MATCHES}, maximum ${MAX_MATCHES}.`,
        },
      },
      required: ['regex'],
    },
  };

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const target = await resolveCleanupTarget(context);
    if (!target) return this.error('Not in a Document Clean Up session.', 'not_cleanup_session');

    // 'g'/'y' make .test() stateful across lines — same reasoning as
    // strip_lines_matching, which tests each line independently.
    const sanitizedFlags = (args.flags ?? '').replace(/[gy]/g, '');
    const compiled = compileSafeRegex(args.regex, sanitizedFlags);
    if (!compiled.ok) return this.error(compiled.error, 'invalid_regex');

    const limit = Math.min(args.maxMatches ?? DEFAULT_MAX_MATCHES, MAX_MATCHES);
    const lines = target.content.split('\n');
    const matches: Match[] = [];
    let matchCount = 0;

    for (let i = 0; i < lines.length; i++) {
      if (!compiled.regex.test(lines[i])) continue;
      matchCount++;
      if (matches.length < limit) {
        const text = lines[i];
        matches.push({
          line: i + 1,
          text: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text,
        });
      }
    }

    return this.success({
      pattern: args.regex,
      matchCount,
      truncated: matchCount > matches.length,
      matches,
    });
  }
}
