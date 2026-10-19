// @vitest-environment happy-dom

/**
 * Unit Tests: the group budget alert email (§23.12, phase 50; `payer_gone`,
 * phase 62).
 *
 * The `payer_gone` kind is the only one that is not about a threshold the admin
 * switched on, so its wording must not claim it is ("this alert is switched
 * on"), must say the shared balance now pays, and must not show the
 * threshold-only figure.
 *
 * @see components/resparkable/emails/group-budget-alert.tsx
 */

import { render } from '@react-email/render';
import { describe, expect, it } from 'vitest';

import {
  GroupBudgetAlertEmail,
  groupBudgetAlertSubject,
  type GroupBudgetAlertKind,
} from '@/components/resparkable/emails/group-budget-alert';

const props = {
  groupName: 'Study Group B',
  balanceCredits: 40,
  figureCredits: 12,
  groupUrl: 'https://app.example.com/resparkable/groups/grp_1',
};

async function text(kind: GroupBudgetAlertKind): Promise<string> {
  return render(<GroupBudgetAlertEmail kind={kind} {...props} />, { plainText: true });
}

describe('groupBudgetAlertSubject', () => {
  it.each([
    ['low_balance', 'Study Group B is running low on credits'],
    ['large_run', 'One run in Study Group B used a large share of its credits'],
    ['payer_gone', "Study Group B's shared balance now pays its running costs"],
  ] as const)('is the right line for %s', (kind, subject) => {
    expect(groupBudgetAlertSubject(kind, 'Study Group B')).toBe(subject);
  });
});

describe('GroupBudgetAlertEmail', () => {
  it('tells admins the payer is no longer an admin and the shared balance pays now', async () => {
    const body = await text('payer_gone');

    expect(body).toContain('is no longer an admin of the group');
    expect(body).toContain("The group's shared balance pays for them from now on.");
    expect(body).toContain('It has 40 credits.');
    expect(body).toContain("You can choose another admin to pay them from the group's page.");
    expect(body).toContain(props.groupUrl);
  });

  it('does not show the threshold figure or the "alert is switched on" footer for payer_gone', async () => {
    const body = await text('payer_gone');

    expect(body).not.toContain('12');
    expect(body).not.toContain('switched on');
    expect(body).toContain('You are receiving this because you are an admin of Study Group B.');
  });

  it('keeps the threshold wording for low_balance', async () => {
    const body = await text('low_balance');

    expect(body).toContain('has 40 credits left');
    expect(body).toContain('12 you asked to hear about');
    expect(body).toContain('this alert is switched on');
    expect(body).not.toContain('no longer an admin');
  });

  it('keeps the run wording for large_run', async () => {
    const body = await text('large_run');

    expect(body).toContain('used 12 credits');
    expect(body).toContain('The group has 40 left.');
    expect(body).not.toContain('no longer an admin');
  });
});
