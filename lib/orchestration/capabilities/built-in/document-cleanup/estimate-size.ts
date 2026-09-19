import { z } from 'zod';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { resolveCleanupTarget } from '@/lib/orchestration/capabilities/built-in/document-cleanup/context';
import {
  getDocumentSizeReport,
  type DocumentSizeReport,
} from '@/lib/orchestration/knowledge/size-report';

const schema = z.object({}).strict();
type Args = z.infer<typeof schema>;

export class EstimateSizeCapability extends BaseCapability<Args, DocumentSizeReport> {
  readonly slug = 'estimate_size';
  protected readonly schema = schema;

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'estimate_size',
    description:
      'Estimate the current document size in tokens and report the size class (small/medium/large/too-large) plus whether whole-doc LLM rewrites are allowed at the current size. Call after a series of deterministic strips to re-check whether LLM rewrite is now feasible. Read-only.',
    parameters: { type: 'object', properties: {} },
  };

  async execute(
    _args: Args,
    context: CapabilityContext
  ): Promise<CapabilityResult<DocumentSizeReport>> {
    const target = await resolveCleanupTarget(context);
    if (!target) return this.error('Not in a Document Clean Up session.', 'not_cleanup_session');
    return this.success(getDocumentSizeReport(target.content));
  }
}
