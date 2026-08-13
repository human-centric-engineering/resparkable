/**
 * Reads of the **core** `AiOrchestrationSettings` singleton Resparkable's
 * capture routes gate on.
 *
 * Same exception `repo/agents.ts` documents, for the same reason: this is
 * instance-wide operator configuration — "no microphones on this instance",
 * "no images on this instance" — not user data, not scoped by anything. It
 * lives in `repo/**` because the tier's rule is "the database is only
 * reachable from here," not "owner-scoped queries go here."
 */

import { prisma } from '@/lib/db/client';

/** The two capture-route kill switches, by the exact column name each gates. */
export type CaptureKillSwitchField = 'voiceInputGloballyEnabled' | 'imageInputGloballyEnabled';

/**
 * Whether the named capture channel is enabled — `false` only when a
 * settings row exists and its column says so. No row at all (a fresh install
 * with no operator opinion set) reads as enabled, not disabled — there is
 * nothing to have turned it off with.
 */
export async function findCaptureKillSwitch(field: CaptureKillSwitchField): Promise<boolean> {
  const settings = await prisma.aiOrchestrationSettings.findUnique({
    where: { slug: 'global' },
    select: { [field]: true },
  });
  return settings ? settings[field] : true;
}
