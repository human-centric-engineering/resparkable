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
  keepBlankLines: z.boolean().optional(),
});

type Args = z.infer<typeof schema>;

interface Data extends MutationSummary {
  keepBlankLines: boolean;
}

export class CollapseWhitespaceCapability extends BaseCapability<Args, Data> {
  readonly slug = 'collapse_whitespace';
  protected readonly schema = schema;

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'collapse_whitespace',
    description:
      'Collapse runs of spaces and tabs to a single space, trim trailing whitespace on each line, and either remove blank lines entirely or collapse consecutive blanks to a single blank. Deterministic — does not consume LLM tokens.',
    parameters: {
      type: 'object',
      properties: {
        keepBlankLines: {
          type: 'boolean',
          description:
            'true = collapse runs of blank lines to a single blank (preserves paragraph breaks). false = remove all blank lines. Default: true.',
        },
      },
    },
  };

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const keepBlankLines = args.keepBlankLines ?? true;
    const outcome = await mutateCleanupContent(
      context,
      { source: 'capability:collapse_whitespace', actorId: context.userId },
      (content) => {
        let next = content
          .split('\n')
          .map((line) => line.replace(/[ \t]+/g, ' ').replace(/\s+$/, ''))
          .join('\n');
        next = keepBlankLines
          ? next.replace(/\n{3,}/g, '\n\n')
          : next
              .split('\n')
              .filter((l) => l.trim() !== '')
              .join('\n');
        return { next, data: { keepBlankLines } };
      }
    );
    if (!outcome.ok) {
      const refusal = describeRefusal(outcome);
      return this.error(refusal.message, refusal.code);
    }
    return this.success({ ...outcome.data, ...outcome.summary });
  }
}
