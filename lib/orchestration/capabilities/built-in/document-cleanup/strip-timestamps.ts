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

const formats = ['hh_mm', 'hh_mm_ss', 'bracketed', 'parenthesised'] as const;

const schema = z.object({
  formats: z.array(z.enum(formats)).optional(),
});

type Args = z.infer<typeof schema>;

interface Data extends MutationSummary {
  formats: string[];
  removed: number;
}

// Matches: 00:00, 0:00, 12:34, etc. Anchored on word boundaries so it doesn't
// nibble random colons mid-word.
const HH_MM = /\b\d{1,2}:\d{2}\b/g;
// Matches: 00:00:00, 1:23:45, etc.
const HH_MM_SS = /\b\d{1,2}:\d{2}:\d{2}\b/g;
// Matches: [00:00], [12:34:56].
const BRACKETED = /\[\d{1,2}(?::\d{2}){1,2}\]/g;
// Matches: (00:00), (12:34:56).
const PARENTHESISED = /\(\d{1,2}(?::\d{2}){1,2}\)/g;

export class StripTimestampsCapability extends BaseCapability<Args, Data> {
  readonly slug = 'strip_timestamps';
  protected readonly schema = schema;

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'strip_timestamps',
    description:
      'Remove timestamp markers from the document (e.g. "00:42", "[01:23:45]", "(12:00)"). Default: all known formats. Deterministic — does not consume LLM tokens.',
    parameters: {
      type: 'object',
      properties: {
        formats: {
          type: 'array',
          description:
            'Subset of timestamp formats to remove. Omit to remove all. "hh_mm" = 00:00, "hh_mm_ss" = 00:00:00, "bracketed" = [00:00], "parenthesised" = (00:00).',
          items: { type: 'string', enum: [...formats] },
        },
      },
    },
  };

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const selected = args.formats ?? [...formats];
    const outcome = await mutateCleanupContent(
      context,
      { source: 'capability:strip_timestamps', actorId: context.userId },
      (content) => {
        let next = content;
        let removed = 0;
        // Order matters: do the longer/bracketed forms first so the plain ones
        // don't eat the inner part and leave dangling brackets.
        if (selected.includes('bracketed')) {
          removed += (next.match(BRACKETED) ?? []).length;
          next = next.replace(BRACKETED, '');
        }
        if (selected.includes('parenthesised')) {
          removed += (next.match(PARENTHESISED) ?? []).length;
          next = next.replace(PARENTHESISED, '');
        }
        if (selected.includes('hh_mm_ss')) {
          removed += (next.match(HH_MM_SS) ?? []).length;
          next = next.replace(HH_MM_SS, '');
        }
        if (selected.includes('hh_mm')) {
          removed += (next.match(HH_MM) ?? []).length;
          next = next.replace(HH_MM, '');
        }
        return { next, data: { formats: selected, removed } };
      }
    );
    if (!outcome.ok) {
      const refusal = describeRefusal(outcome);
      return this.error(refusal.message, refusal.code);
    }
    return this.success({ ...outcome.data, ...outcome.summary });
  }
}
