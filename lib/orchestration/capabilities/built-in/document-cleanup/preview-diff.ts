import { z } from 'zod';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { resolveCleanupTarget } from '@/lib/orchestration/capabilities/built-in/document-cleanup/context';

const schema = z.object({}).strict();
type Args = z.infer<typeof schema>;

interface Data {
  charsOriginal: number;
  charsCurrent: number;
  charsRemoved: number;
  linesOriginal: number;
  linesCurrent: number;
  linesRemoved: number;
  reductionPct: number;
}

export class PreviewDiffCapability extends BaseCapability<Args, Data> {
  readonly slug = 'preview_diff';
  protected readonly schema = schema;

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'preview_diff',
    description:
      'Summarise the difference between the original and current state of the document being cleaned (characters/lines removed, percent reduction). Read-only — does not mutate the document. The admin sees the actual diff in the cleanup page UI; this gives you a numeric summary to narrate.',
    parameters: { type: 'object', properties: {} },
  };

  async execute(_args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const target = await resolveCleanupTarget(context);
    if (!target) return this.error('Not in a Document Clean Up session.', 'not_cleanup_session');

    const orig = target.originalContent;
    const cur = target.content;
    const linesOriginal = orig.split('\n').length;
    const linesCurrent = cur.split('\n').length;
    return this.success({
      charsOriginal: orig.length,
      charsCurrent: cur.length,
      charsRemoved: orig.length - cur.length,
      linesOriginal,
      linesCurrent,
      linesRemoved: linesOriginal - linesCurrent,
      reductionPct: orig.length === 0 ? 0 : ((orig.length - cur.length) / orig.length) * 100,
    });
  }
}
