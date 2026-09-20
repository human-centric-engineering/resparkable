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

const schema = z.object({
  format: z.enum(['colon', 'bracketed', 'both']).optional(),
});

type Args = z.infer<typeof schema>;

interface Data extends MutationSummary {
  format: 'colon' | 'bracketed' | 'both';
  removed: number;
}

// "John:", "Mary Smith:" at start of line. Allows 1-4 capitalised words.
// Horizontal whitespace only: `\s` also matches `\n`, so under the `m` flag a
// match could start on one line and finish on the next — "Introduction\nBob:"
// would delete the "Introduction" heading and join the lines.
const COLON = /^([A-Z][A-Za-z'’-]+)([ \t]+[A-Z][A-Za-z'’-]+){0,3}:[ \t]?/gm;
// "[John]", "[Mary Smith]" at start of line (transcript convention).
const BRACKETED = /^\[([A-Z][A-Za-z'’-]+)([ \t]+[A-Z][A-Za-z'’-]+){0,3}\][ \t]?/gm;

export class StripSpeakerLabelsCapability extends BaseCapability<Args, Data> {
  readonly slug = 'strip_speaker_labels';
  protected readonly schema = schema;

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'strip_speaker_labels',
    description:
      'Remove speaker labels at the start of lines (e.g. "John:", "Mary Smith:", "[John]"). Useful for cleaning interview/podcast transcripts. Deterministic — does not consume LLM tokens.',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['colon', 'bracketed', 'both'],
          description:
            '"colon" = "Name:" form; "bracketed" = "[Name]" form; "both" = strip either. Default: "both".',
        },
      },
    },
  };

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const format = args.format ?? 'both';
    const outcome = await mutateCleanupContent(
      context,
      { source: 'capability:strip_speaker_labels', actorId: context.userId },
      (content) => {
        let next = content;
        let removed = 0;
        if (format === 'colon' || format === 'both') {
          removed += (next.match(COLON) ?? []).length;
          next = next.replace(COLON, '');
        }
        if (format === 'bracketed' || format === 'both') {
          removed += (next.match(BRACKETED) ?? []).length;
          next = next.replace(BRACKETED, '');
        }
        return { next, data: { format, removed } };
      }
    );
    if (!outcome.ok) {
      const refusal = describeRefusal(outcome);
      return this.error(refusal.message, refusal.code);
    }
    return this.success({ ...outcome.data, ...outcome.summary });
  }
}
