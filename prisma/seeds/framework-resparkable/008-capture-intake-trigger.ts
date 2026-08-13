import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { RESPARKABLE_CAPTURE_INTAKE_WORKFLOW_SLUG } from '@/lib/framework/resparkable/workflows/definitions';

/**
 * Point Postmark's inbound-parse adapter at `resparkable-capture-intake`.
 *
 * **Zero adapter code, same as every other channel in `lib/orchestration/inbound/`**
 * — the Postmark adapter, the route and the Basic-auth verification all already
 * exist (`.context/orchestration/inbound-triggers.md`) and self-register from
 * `POSTMARK_INBOUND_USER`/`POSTMARK_INBOUND_PASS`. This seed is the one row that
 * says "when Postmark delivers, run this workflow" — the row the doc's own
 * quick-start says a fork inserts by hand.
 *
 * **No `metadata.eventTypes` filter.** Postmark only ever delivers
 * `inbound_email` (`postmark.ts`'s `normalise()` hard-codes it), so an allow-
 * list here would filter nothing and only be one more place to keep in sync.
 *
 * **`RESPARKABLE_INBOX_DOMAIN` still has to be set by the operator**, and DNS
 * still has to route mail there — this row makes the workflow *reachable*, not
 * the mailbox *live*. See `install.md` and `capture-channels.md`.
 */
const unit: SeedUnit = {
  name: 'framework-resparkable/008-capture-intake-trigger',
  hashInputs: ['../../../lib/framework/resparkable/workflows/definitions.ts'],
  async run({ prisma, logger }) {
    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    const workflow = await prisma.aiWorkflow.findUnique({
      where: { slug: RESPARKABLE_CAPTURE_INTAKE_WORKFLOW_SLUG },
      select: { id: true },
    });
    if (!workflow) {
      throw new Error(
        `framework-resparkable/008-capture-intake-trigger: no AiWorkflow row for ` +
          `"${RESPARKABLE_CAPTURE_INTAKE_WORKFLOW_SLUG}". Run framework-resparkable/005-workflows first.`
      );
    }

    await prisma.aiWorkflowTrigger.upsert({
      where: { channel_workflowId: { channel: 'postmark', workflowId: workflow.id } },
      // Nothing to refresh: `name` is cosmetic and `isEnabled` is an operator's
      // to hold, same reasoning `004-agent-capabilities` gives for its own
      // empty update branch.
      update: {},
      create: {
        workflowId: workflow.id,
        channel: 'postmark',
        name: 'Resparkable inbound email',
        isEnabled: true,
        createdBy: admin.id,
      },
    });

    logger.info('✅ Resparkable capture-intake trigger: postmark → resparkable-capture-intake');
  },
};

export default unit;
