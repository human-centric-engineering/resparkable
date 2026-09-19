import { z } from 'zod';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import {
  compileSafeRegex,
  describeRefusal,
  MutationSummary,
  mutateCleanupContent,
} from '@/lib/orchestration/capabilities/built-in/document-cleanup/context';

const schema = z.object({
  regex: z.string().min(1).max(500),
  flags: z.string().max(8).optional(),
});

type Args = z.infer<typeof schema>;

interface Data extends MutationSummary {
  pattern: string;
  matchCount: number;
}

export class StripMatchesCapability extends BaseCapability<Args, Data> {
  readonly slug = 'strip_matches';
  protected readonly schema = schema;

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'strip_matches',
    description:
      'Remove inline occurrences of the given regex from the document, leaving the surrounding text intact. Use for noise that appears mid-line (e.g. inline timestamps, footnote markers). Deterministic — does not consume LLM tokens. The "g" flag is forced on so all matches are removed.',
    parameters: {
      type: 'object',
      properties: {
        regex: {
          type: 'string',
          description: 'Regex pattern (no surrounding slashes).',
        },
        flags: {
          type: 'string',
          description: 'Regex flags. "g" is always added. Default: "".',
        },
      },
      required: ['regex'],
    },
  };

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    // 'y' (sticky) anchors each attempt at lastIndex, so a 'gy' pattern makes
    // String.replace stop at the first non-contiguous match — it would strip a
    // leading prefix of the intended matches and still report the partial
    // count as the total. It adds nothing to a whole-document replace, so it
    // is dropped rather than passed through (same reasoning as the 'g'/'y'
    // strip in strip_lines_matching). 'g' is then forced on.
    const flags = `${(args.flags ?? '').replace(/[gy]/g, '')}g`;
    const compiled = compileSafeRegex(args.regex, flags);
    if (!compiled.ok) {
      return this.error(compiled.error, 'invalid_regex');
    }
    const pattern = compiled.regex;

    const outcome = await mutateCleanupContent(
      context,
      { source: 'capability:strip_matches', actorId: context.userId },
      (content) => {
        const matches = content.match(pattern);
        return {
          next: content.replace(pattern, ''),
          data: { pattern: args.regex, matchCount: matches?.length ?? 0 },
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
