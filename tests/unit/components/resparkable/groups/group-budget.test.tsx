// @vitest-environment happy-dom

/**
 * GroupBudget Component Tests (§23.12, phase 50, reworked for phase 62).
 *
 * `budget.admin` is `null` for anybody who is not an admin, so the assertions
 * that matter are about what a member's browser never receives at all, not
 * about a role check hiding a rendered element:
 *
 *   1. **Everyone reads how the group pays**, in sentences built from the
 *      settings, and sees a change that is waiting for next month.
 *   2. **A member sees their own money**, adds to it with `to: 'me'` and sets
 *      their own automatic top-up. Nobody else's money is on this panel; where
 *      credits went is in the books (`group-books.test.tsx`).
 *   3. **An admin changes who pays** through a form that PATCHes the whole
 *      settings object (for next month) and can cancel a waiting change.
 *   4. **Server figures win over guesses**: a balance shown after a top-up is
 *      the one the server returned.
 *
 * @see components/resparkable/groups/group-budget.tsx
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class extends Error {},
}));

// Radix `Select` renders its dropdown through a portal happy-dom does not
// support, so the funding-mode control is mocked to a native `<select>`: the
// same approach `share-dialog.test.tsx` takes. The goal is to prove this panel
// wires `onValueChange` to the right PATCH, not to re-test Radix.
vi.mock('@/components/ui/select', () => {
  function SelectTrigger({
    children,
  }: {
    id?: string;
    'aria-label'?: string;
    children: React.ReactNode;
  }) {
    return <>{children}</>;
  }

  function Select({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) {
    const trigger = React.Children.toArray(children).find(
      (child): child is React.ReactElement<{ id?: string; 'aria-label'?: string }> =>
        React.isValidElement(child) && child.type === SelectTrigger
    );
    return (
      <select
        id={trigger?.props.id}
        aria-label={trigger?.props['aria-label']}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {children}
      </select>
    );
  }

  return {
    Select,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
    SelectTrigger,
    SelectValue: () => null,
  };
});

import { GroupBudget, describeWhoPays } from '@/components/resparkable/groups/group-budget';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type {
  GroupBillingSettingsWire,
  GroupBudgetWire,
} from '@/lib/framework/resparkable/ui/payloads';
import {
  POOL_SETTINGS,
  makeBilling,
  makeBudget,
  makeYou,
} from '@/tests/helpers/resparkable-group-budget';

const SHARED_TOP_UP_URL = RESPARKABLE_API.groupTopUp('grp_1');

const MEMBER_BUDGET: GroupBudgetWire = makeBudget({
  balanceCredits: 40,
  yourPersonalBalanceCredits: 15,
});

const ADMIN_BUDGET: GroupBudgetWire = makeBudget({
  balanceCredits: 100,
  yourPersonalBalanceCredits: 50,
  admin: {
    lowBalanceAlertCredits: null,
    largeRunAlertPercent: null,
    members: [
      {
        userId: 'user_a',
        name: 'Ada Lovelace',
        role: 'admin',
        dailyCreditCap: null,
        allowanceCredits: null,
      },
      {
        userId: 'user_b',
        name: 'Bailey Chen',
        role: 'member',
        dailyCreditCap: 10,
        allowanceCredits: 25,
      },
    ],
  },
});

function settings(overrides: Partial<GroupBillingSettingsWire>): GroupBillingSettingsWire {
  return { ...POOL_SETTINGS, ...overrides };
}

function withSettings(
  base: GroupBudgetWire,
  overrides: Partial<GroupBillingSettingsWire>,
  billing: Partial<GroupBudgetWire['billing']> = {}
): GroupBudgetWire {
  return { ...base, billing: makeBilling({ settings: settings(overrides), ...billing }) };
}

function renderBudget(budget: GroupBudgetWire, viewerUserId = 'user_b', yourRole = 'member') {
  return render(
    <GroupBudget yourRole={yourRole} groupId="grp_1" budget={budget} viewerUserId={viewerUserId} />
  );
}

/** The Add button belonging to the form that holds `input`, since there are several. */
function addButtonFor(input: HTMLElement): HTMLElement {
  const form = input.closest('form');
  if (!form) throw new Error('input is not in a form');
  return within(form).getByRole('button', { name: 'Add' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('describeWhoPays', () => {
  it.each([
    [
      { activityCostsPaidBy: 'pool' as const },
      "When anyone uses a feature that costs credits, the group's shared balance pays.",
    ],
    [
      { activityCostsPaidBy: 'equal_split' as const },
      'When anyone uses a feature that costs credits, the cost is shared equally between every admin and member, from each person’s own balance in the group.',
    ],
    [
      { activityCostsPaidBy: 'allowance' as const, allowanceSource: 'carved' as const },
      "Each person can use up to their monthly allowance from the group's shared balance. Unused allowance carries over.",
    ],
    [
      { activityCostsPaidBy: 'allowance' as const, allowanceSource: 'filled' as const },
      'Each person pays for what they use from their own balance in the group.',
    ],
  ])('says who pays for activity under %j', (overrides, sentence) => {
    expect(describeWhoPays(settings(overrides), null)[0]).toBe(sentence);
  });

  it('ignores the allowance source unless the group pays by allowance', () => {
    // A stale `filled` left over from an earlier choice must not change the sentence.
    expect(
      describeWhoPays(settings({ activityCostsPaidBy: 'pool', allowanceSource: 'filled' }), null)
    ).toEqual(describeWhoPays(settings({ activityCostsPaidBy: 'pool' }), null));
  });

  it.each([
    [
      { operationalCostsPaidBy: 'pool' as const },
      null,
      "The shared balance pays the group's running costs, such as the weekly summary.",
    ],
    [
      { operationalCostsPaidBy: 'one_admin' as const },
      'Priya Patel',
      "Priya Patel pays the group's running costs, such as the weekly summary.",
    ],
    [
      { operationalCostsPaidBy: 'one_admin' as const },
      null,
      "One of the admins pays the group's running costs, such as the weekly summary.",
    ],
    [
      { operationalCostsPaidBy: 'admins_split' as const },
      null,
      "The admins share the group's running costs, such as the weekly summary.",
    ],
  ])('says who pays running costs under %j (payer %s)', (overrides, payerName, sentence) => {
    expect(describeWhoPays(settings(overrides), payerName)[1]).toBe(sentence);
  });

  it('adds a seat sentence, with the three prices, only when a price is above zero', () => {
    const free = describeWhoPays(POOL_SETTINGS, null);
    const priced = describeWhoPays(
      settings({ seatPriceMemberCredits: 5, seatPriceAdminCredits: 8, seatPriceViewerCredits: 0 }),
      null
    );

    expect(free.some((line) => line.includes('A place in the group'))).toBe(false);
    expect(priced).toContain(
      'A place in the group costs 5 credits a month for a member, 8 for an admin and 0 for a viewer, paid from your own balance in the group. The month you join in is free.'
    );
    expect(priced).toHaveLength(free.length + 1);
  });

  it.each([
    ['seatPriceAdminCredits' as const],
    ['seatPriceMemberCredits' as const],
    ['seatPriceViewerCredits' as const],
  ])('mentions places when only %s is above zero', (key) => {
    const lines = describeWhoPays(settings({ [key]: 1 }), null);

    expect(lines.some((line) => line.includes('A place in the group'))).toBe(true);
  });

  it.each([
    ['debt' as const, /you can carry on while the shared balance can cover you/],
    ['suspend' as const, /you cannot use features that cost credits until you add enough/],
  ])('ends with the %s shortfall sentence', (shortfallPolicy, pattern) => {
    const lines = describeWhoPays(settings({ shortfallPolicy }), null);

    expect(lines[lines.length - 1]).toMatch(pattern);
  });
});

describe('GroupBudget for a member', () => {
  it('shows the shared balance, how the group pays, and nothing about anyone else', () => {
    renderBudget(MEMBER_BUDGET);

    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByText('How the group pays')).toBeInTheDocument();
    expect(
      screen.getByText(
        "When anyone uses a feature that costs credits, the group's shared balance pays."
      )
    ).toBeInTheDocument();
    // The old per-person spend table is gone; the books carry that.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Only admins see this part.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save for next month' })).not.toBeInTheDocument();
  });

  it('names the admin who pays running costs', () => {
    renderBudget(
      withSettings(
        MEMBER_BUDGET,
        { operationalCostsPaidBy: 'one_admin', operationalPayerUserId: 'user_p' },
        { operationalPayerName: 'Priya Patel' }
      )
    );

    expect(
      screen.getByText("Priya Patel pays the group's running costs, such as the weekly summary.")
    ).toBeInTheDocument();
  });

  it('shows a change that is waiting, dated on the group’s own calendar', () => {
    renderBudget({
      ...MEMBER_BUDGET,
      billing: makeBilling({
        pending: {
          settings: settings({ activityCostsPaidBy: 'equal_split' }),
          from: '2026-11-05T00:00:00.000Z',
        },
      }),
    });

    expect(screen.getByText('From 5 November:')).toBeInTheDocument();
    // Both versions are written out: what applies now, and what will.
    expect(
      screen.getByText(
        "When anyone uses a feature that costs credits, the group's shared balance pays."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(/the cost is shared equally between every admin and member/)
    ).toBeInTheDocument();
  });

  it('dates the waiting change in the group’s time zone, not the reader’s', () => {
    // 23:00 UTC on the 4th is already the 5th in Auckland.
    renderBudget({
      ...MEMBER_BUDGET,
      billing: makeBilling({
        timeZone: 'Pacific/Auckland',
        pending: { settings: POOL_SETTINGS, from: '2026-11-04T23:00:00.000Z' },
      }),
    });

    expect(screen.getByText('From 5 November:')).toBeInTheDocument();
  });

  it('shows no notice when nothing is waiting', () => {
    renderBudget(MEMBER_BUDGET);

    expect(screen.queryByText(/^From /)).not.toBeInTheDocument();
  });

  it('keeps the personal-balance block out of a group where the pool pays and the balance is zero', () => {
    renderBudget(MEMBER_BUDGET);

    expect(screen.queryByText(/Your balance in this group is/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('spinbutton', { name: /Top up automatically/ })
    ).not.toBeInTheDocument();
  });

  it.each([
    ['equal split', { activityCostsPaidBy: 'equal_split' as const }],
    [
      'a filled allowance',
      { activityCostsPaidBy: 'allowance' as const, allowanceSource: 'filled' as const },
    ],
    ['an admin paying running costs', { operationalCostsPaidBy: 'one_admin' as const }],
    ['a priced place', { seatPriceMemberCredits: 3 }],
  ])('shows the personal balance when the group uses it through %s', (_name, overrides) => {
    renderBudget(
      withSettings({ ...MEMBER_BUDGET, you: makeYou({ balanceCredits: 6.25 }) }, overrides)
    );

    expect(screen.getByText(/Your balance in this group is/)).toBeInTheDocument();
    expect(screen.getByText('6.25')).toBeInTheDocument();
  });

  it('shows the personal balance for a change that is only pending, so it is not a surprise', () => {
    renderBudget({
      ...MEMBER_BUDGET,
      billing: makeBilling({
        pending: {
          settings: settings({ activityCostsPaidBy: 'equal_split' }),
          from: '2026-11-05T00:00:00.000Z',
        },
      }),
    });

    expect(screen.getByText(/Your balance in this group is/)).toBeInTheDocument();
  });

  it('shows the personal balance whenever it is not zero, even in a pool-pays group', () => {
    renderBudget({ ...MEMBER_BUDGET, you: makeYou({ balanceCredits: 3 }) });

    expect(screen.getByText(/Your balance in this group is/)).toBeInTheDocument();
  });

  it('tells somebody who owes that their next top-up pays it back first', () => {
    renderBudget({ ...MEMBER_BUDGET, you: makeYou({ balanceCredits: -4 }) });

    expect(
      screen.getByText('You owe the group 4 credits. Your next top-up pays it back first.')
    ).toBeInTheDocument();
  });

  it('tells a paused member how much to add before they can carry on', () => {
    renderBudget({ ...MEMBER_BUDGET, you: makeYou({ balanceCredits: -4, suspended: true }) });

    expect(
      screen.getByText(
        'You owe the group 4 credits. Add at least that much to use features that cost credits again.'
      )
    ).toBeInTheDocument();
  });

  it('shows what is left of a carved allowance and how much is added each month', () => {
    const carved = withSettings(
      {
        ...MEMBER_BUDGET,
        you: makeYou({ allowanceCredits: 30, allowanceRemainingCredits: 12, balanceCredits: 2 }),
      },
      { activityCostsPaidBy: 'allowance', allowanceSource: 'carved' }
    );
    renderBudget(carved);

    expect(
      screen.getByText('Allowance left from the shared balance: 12 (30 is added each month).')
    ).toBeInTheDocument();
  });

  // A carved allowance is paid from the pool, but how much is left is about the
  // person, so it shows even when their own balance in the group is zero.
  it('shows a carved allowance to a member whose own balance is zero', () => {
    const carved = withSettings(
      {
        ...MEMBER_BUDGET,
        you: makeYou({ allowanceCredits: 30, allowanceRemainingCredits: 12, balanceCredits: 0 }),
      },
      { activityCostsPaidBy: 'allowance', allowanceSource: 'carved' }
    );
    renderBudget(carved);

    expect(screen.getByText(/Allowance left from the shared balance: 12/)).toBeInTheDocument();
  });

  it('shows the spending ceiling of a filled allowance, and no allowance line when none is set', () => {
    const filled = {
      activityCostsPaidBy: 'allowance' as const,
      allowanceSource: 'filled' as const,
    };
    const { unmount } = renderBudget(
      withSettings({ ...MEMBER_BUDGET, you: makeYou({ allowanceCredits: 20 }) }, filled)
    );
    expect(
      screen.getByText('You can spend up to 20 of your balance here each month.')
    ).toBeInTheDocument();
    unmount();

    renderBudget(
      withSettings({ ...MEMBER_BUDGET, you: makeYou({ allowanceCredits: null }) }, filled)
    );
    expect(screen.queryByText(/You can spend up to/)).not.toBeInTheDocument();
  });

  it('shows a member their own daily limit sentence when one is set', () => {
    renderBudget({
      ...MEMBER_BUDGET,
      you: makeYou({ dailyCreditCap: 20, spentLastDayCredits: 7 }),
    });

    expect(
      screen.getByText(/You can use up to 20 credits here in any 24 hours\. You have used 7\./)
    ).toBeInTheDocument();
  });

  it('updates the shown balance when a new balanceCredits prop arrives, without remounting', () => {
    const { rerender } = renderBudget(MEMBER_BUDGET);
    expect(screen.getByText('40')).toBeInTheDocument();

    rerender(
      <GroupBudget
        yourRole="member"
        groupId="grp_1"
        budget={{ ...MEMBER_BUDGET, balanceCredits: 65 }}
        viewerUserId="user_b"
      />
    );

    expect(screen.getByText('65')).toBeInTheDocument();
  });
});

describe('GroupBudget adding to the shared balance', () => {
  it('posts the typed amount (with no destination) and shows the balance the server returned', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue({ balanceCredits: 65 });

    renderBudget(MEMBER_BUDGET);
    await user.type(
      screen.getByRole('spinbutton', { name: /Add credits to the shared balance/ }),
      '10'
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(apiClient.post).toHaveBeenCalledWith(SHARED_TOP_UP_URL, { body: { credits: 10 } });
    // The server's figure, not 40 + 10 worked out client-side.
    expect(await screen.findByText('65')).toBeInTheDocument();
  });

  it('tells a member in a self-funded group that admins add to the shared balance', () => {
    renderBudget({ ...MEMBER_BUDGET, canTopUp: false });

    expect(
      screen.getByText('In this group, admins add to the shared balance.')
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('spinbutton', { name: /Add credits to the shared balance/ })
    ).not.toBeInTheDocument();
  });

  it('tells a viewer they do not add, in either funding mode, and never that admins do', () => {
    const { unmount } = renderBudget(
      { ...MEMBER_BUDGET, fundingMode: 'member_contributions', canTopUp: false },
      'user_v',
      'viewer'
    );
    expect(screen.getByText('Viewers do not add to the shared balance.')).toBeInTheDocument();
    unmount();

    renderBudget(
      { ...MEMBER_BUDGET, fundingMode: 'self_funded', canTopUp: false },
      'user_v',
      'viewer'
    );
    expect(screen.getByText('Viewers do not add to the shared balance.')).toBeInTheDocument();
    expect(screen.queryByText(/admins add/)).not.toBeInTheDocument();
  });

  it('does nothing when the typed amount is not a usable number', async () => {
    const user = userEvent.setup();

    renderBudget(MEMBER_BUDGET);
    await user.type(
      screen.getByRole('spinbutton', { name: /Add credits to the shared balance/ }),
      '-5'
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('keeps the balance shown when the request fails', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockRejectedValue(new Error('server exploded'));

    renderBudget(MEMBER_BUDGET);
    await user.type(
      screen.getByRole('spinbutton', { name: /Add credits to the shared balance/ }),
      '10'
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText('server exploded')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
  });

  it('refuses an amount above the server’s ceiling in plain words, without a request', async () => {
    const user = userEvent.setup();

    renderBudget(ADMIN_BUDGET, 'user_a', 'admin');
    await user.type(
      screen.getByRole('spinbutton', { name: /Add credits to the shared balance/ }),
      '2000000'
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(apiClient.post).not.toHaveBeenCalled();
    expect(await screen.findByText(/Add between 0 and 1,000,000 credits/)).toBeInTheDocument();
  });
});

describe('GroupBudget your own money', () => {
  const OWN = withSettings(
    { ...MEMBER_BUDGET, you: makeYou({ balanceCredits: 9 }) },
    { activityCostsPaidBy: 'equal_split' }
  );

  it('adds to your own balance with to: "me" and shows the balance the server returned', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue({ memberBalanceCredits: 21 });

    renderBudget(OWN);
    const input = screen.getByRole('spinbutton', {
      name: /Add credits to your balance in this group/,
    });
    await user.type(input, '12');
    await user.click(addButtonFor(input));

    expect(apiClient.post).toHaveBeenCalledWith(SHARED_TOP_UP_URL, {
      body: { credits: 12, to: 'me' },
    });
    expect(await screen.findByText('21')).toBeInTheDocument();
    // The shared balance is untouched by adding to your own.
    expect(screen.getByText('40')).toBeInTheDocument();
  });

  it('sends nothing for an amount that is not usable', async () => {
    const user = userEvent.setup();

    renderBudget(OWN);
    const input = screen.getByRole('spinbutton', {
      name: /Add credits to your balance in this group/,
    });
    await user.type(input, '0');
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(await screen.findByText(/Add between 0 and 1,000,000 credits/)).toBeInTheDocument();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('shows the current automatic top-up and saves a new one to the member’s own budget', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    renderBudget({ ...OWN, you: makeYou({ balanceCredits: 9, autoTopUpMonthlyCredits: 30 }) });
    const input = screen.getByRole<HTMLInputElement>('spinbutton', {
      name: /Top up automatically/,
    });
    expect(input.value).toBe('30');
    await user.clear(input);
    await user.type(input, '45');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(apiClient.patch).toHaveBeenCalledWith(RESPARKABLE_API.groupOwnBudget('grp_1'), {
      body: { autoTopUpMonthlyCredits: 45 },
    });
  });

  it('switches the automatic top-up off by saving a blank box', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    renderBudget({ ...OWN, you: makeYou({ balanceCredits: 9, autoTopUpMonthlyCredits: 30 }) });
    await user.clear(screen.getByRole('spinbutton', { name: /Top up automatically/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(apiClient.patch).toHaveBeenCalledWith(RESPARKABLE_API.groupOwnBudget('grp_1'), {
      body: { autoTopUpMonthlyCredits: null },
    });
  });

  it('sends nothing for an automatic top-up that is not a usable number, and says why', async () => {
    const user = userEvent.setup();

    renderBudget(OWN);
    const input = screen.getByRole('spinbutton', { name: /Top up automatically/ });
    await user.type(input, '-3');
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(
      await screen.findByText('An automatic top-up must be a number of credits, or blank for off.')
    ).toBeInTheDocument();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });
});

describe('GroupBudget admin controls', () => {
  function renderAdmin(budget: GroupBudgetWire = ADMIN_BUDGET, viewerUserId = 'user_a') {
    return renderBudget(budget, viewerUserId, 'admin');
  }

  it('shows an admin the who-pays form and the limits table, with members by name and no spend', () => {
    renderAdmin();

    expect(screen.getByText('Only admins see this part.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save for next month' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(table).toHaveTextContent('You');
    expect(table).toHaveTextContent('Bailey Chen');
    expect(table).not.toHaveTextContent('user_a');
    expect(table).not.toHaveTextContent('user_b');
    expect(within(table).queryByText('Spent')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: /spent|contributed/i })
    ).not.toBeInTheDocument();
  });

  it('calls a member with no name set "A member", not their id', () => {
    renderAdmin({
      ...ADMIN_BUDGET,
      admin: {
        ...ADMIN_BUDGET.admin!,
        members: [
          ...ADMIN_BUDGET.admin!.members,
          {
            userId: 'user_n',
            name: null,
            role: 'member',
            dailyCreditCap: null,
            allowanceCredits: null,
          },
        ],
      },
    });

    expect(screen.getByLabelText('Daily limit for A member')).toBeInTheDocument();
    expect(screen.getByRole('table')).not.toHaveTextContent('user_n');
  });

  it('shows a viewer row as plain text, not an editable box', () => {
    renderAdmin({
      ...ADMIN_BUDGET,
      admin: {
        ...ADMIN_BUDGET.admin!,
        members: [
          ...ADMIN_BUDGET.admin!.members,
          {
            userId: 'user_v',
            name: 'Val Viewer',
            role: 'viewer',
            dailyCreditCap: null,
            allowanceCredits: null,
          },
        ],
      },
    });

    expect(screen.getByText('Viewer')).toBeInTheDocument();
    expect(screen.queryByLabelText('Daily limit for Val Viewer')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Daily limit for You')).toBeInTheDocument();
    expect(screen.getByLabelText('Daily limit for Bailey Chen')).toBeInTheDocument();
  });

  it('shows the allowance column only when the group pays by allowance, now or from next month', () => {
    const { unmount } = renderAdmin();
    expect(
      screen.queryByRole('columnheader', { name: 'Monthly allowance' })
    ).not.toBeInTheDocument();
    unmount();

    const { unmount: unmountNow } = renderAdmin(
      withSettings(ADMIN_BUDGET, { activityCostsPaidBy: 'allowance' })
    );
    expect(screen.getByRole('columnheader', { name: 'Monthly allowance' })).toBeInTheDocument();
    unmountNow();

    renderAdmin({
      ...ADMIN_BUDGET,
      billing: makeBilling({
        pending: {
          settings: settings({ activityCostsPaidBy: 'allowance' }),
          from: '2026-11-05T00:00:00.000Z',
        },
      }),
    });
    expect(screen.getByRole('columnheader', { name: 'Monthly allowance' })).toBeInTheDocument();
  });

  it('saves a member’s monthly allowance on blur, and sends nothing for an unchanged box', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    renderAdmin(withSettings(ADMIN_BUDGET, { activityCostsPaidBy: 'allowance' }));
    const box = screen.getByLabelText('Monthly allowance for Bailey Chen');
    await user.click(box);
    await user.tab();
    expect(apiClient.patch).not.toHaveBeenCalled();

    await user.clear(box);
    await user.type(box, '40');
    await user.tab();

    expect(apiClient.patch).toHaveBeenCalledWith(
      RESPARKABLE_API.groupMemberCap('grp_1', 'user_b'),
      { body: { allowanceCredits: 40 } }
    );
  });

  it('refuses a negative allowance in plain words', async () => {
    const user = userEvent.setup();

    renderAdmin(withSettings(ADMIN_BUDGET, { activityCostsPaidBy: 'allowance' }));
    const box = screen.getByLabelText('Monthly allowance for Bailey Chen');
    await user.clear(box);
    await user.type(box, '-5');
    await user.tab();

    expect(
      await screen.findByText('A monthly allowance must be a number of credits, or blank for none.')
    ).toBeInTheDocument();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it('patches the funding mode when an admin changes it, by group and mode', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    renderAdmin();
    await user.selectOptions(
      screen.getByRole('combobox', { name: /Who adds to the shared balance/ }),
      'member_contributions'
    );

    expect(apiClient.patch).toHaveBeenCalledWith(RESPARKABLE_API.groupBudget('grp_1'), {
      body: { fundingMode: 'member_contributions' },
    });
  });

  it('rolls the funding mode back to what it was when the PATCH fails', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockRejectedValue(new Error('nope'));

    renderAdmin();
    const select = screen.getByRole<HTMLSelectElement>('combobox', {
      name: /Who adds to the shared balance/,
    });
    await user.selectOptions(select, 'member_contributions');

    await screen.findByText('nope');
    expect(select.value).toBe('self_funded');
  });

  it('saves the alert thresholds, sending null for a blank field', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    renderAdmin();
    await user.type(
      screen.getByRole('spinbutton', { name: /Email me when the shared balance falls to/ }),
      '50'
    );
    await user.click(screen.getByRole('button', { name: 'Save alerts' }));

    expect(apiClient.patch).toHaveBeenCalledWith(RESPARKABLE_API.groupBudget('grp_1'), {
      body: { lowBalanceAlertCredits: 50, largeRunAlertPercent: null },
    });
  });

  it('sends nothing when the large-run field is not a usable number, and says why', async () => {
    const user = userEvent.setup();

    renderAdmin();
    const input = screen.getByRole('spinbutton', { name: /or one run uses more than/ });
    await user.type(input, '-3');
    // `min={1}` stops a real click first; submitting directly exercises this
    // component's own check.
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(
      await screen.findByText(
        'The large run alert must be a whole number from 1 to 100, or blank for off.'
      )
    ).toBeInTheDocument();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it('sends nothing when the low-balance field is not a usable number, and says why', async () => {
    const user = userEvent.setup();

    renderAdmin();
    const input = screen.getByRole('spinbutton', {
      name: /Email me when the shared balance falls to/,
    });
    await user.type(input, '-5');
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(
      await screen.findByText(
        'The low balance alert must be a number of credits, or blank for off.'
      )
    ).toBeInTheDocument();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it.each(['12.5', '0', '101'])(
    'sends nothing for a large-run share of %s, which the server would refuse',
    async (share) => {
      const user = userEvent.setup();

      renderAdmin();
      await user.type(screen.getByRole('spinbutton', { name: /or one run uses more than/ }), share);
      await user.click(screen.getByRole('button', { name: 'Save alerts' }));

      expect(apiClient.patch).not.toHaveBeenCalled();
    }
  );

  it('updates your own limit line when you save a cap for yourself', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    renderAdmin();
    expect(screen.queryByText(/You can use up to/)).toBeNull();

    await user.type(screen.getByLabelText('Daily limit for You'), '5');
    await user.tab();

    expect(screen.getByText(/You can use up to 5 credits here/)).toBeInTheDocument();
  });

  it('saves a member’s daily cap on blur', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    renderAdmin();
    const capInput = screen.getByLabelText('Daily limit for Bailey Chen');
    await user.clear(capInput);
    await user.type(capInput, '30');
    await user.tab();

    expect(apiClient.patch).toHaveBeenCalledWith(
      RESPARKABLE_API.groupMemberCap('grp_1', 'user_b'),
      { body: { dailyCreditCap: 30 } }
    );
  });

  it('clears a member’s daily cap by blurring a blank field', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    renderAdmin();
    const capInput = screen.getByLabelText('Daily limit for Bailey Chen');
    await user.clear(capInput);
    await user.tab();

    expect(apiClient.patch).toHaveBeenCalledWith(
      RESPARKABLE_API.groupMemberCap('grp_1', 'user_b'),
      { body: { dailyCreditCap: null } }
    );
  });

  it('does not call the API when a typed cap is not a usable number, and says why', async () => {
    const user = userEvent.setup();

    renderAdmin();
    const capInput = screen.getByLabelText('Daily limit for Bailey Chen');
    await user.clear(capInput);
    await user.type(capInput, '-5');
    await user.tab();

    expect(
      await screen.findByText('A daily limit must be a number of credits, or blank for no limit.')
    ).toBeInTheDocument();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it('sends nothing on a later blur after a cap save succeeded, unless the value changes again', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    renderAdmin();
    const capInput = screen.getByLabelText('Daily limit for Bailey Chen');
    await user.clear(capInput);
    await user.type(capInput, '30');
    await user.tab();
    expect(apiClient.patch).toHaveBeenCalledTimes(1);

    vi.mocked(apiClient.patch).mockClear();
    await user.click(capInput);
    await user.tab();

    expect(apiClient.patch).not.toHaveBeenCalled();
  });
});

describe('GroupBudget the who-pays form', () => {
  const SAVE_URL = RESPARKABLE_API.groupBudget('grp_1');

  function renderAdmin(budget: GroupBudgetWire = ADMIN_BUDGET) {
    return renderBudget(budget, 'user_a', 'admin');
  }

  it('starts from the settings in force and saves them all, for next month', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ billing: { pending: null } });

    renderAdmin();
    await user.selectOptions(
      screen.getByRole('combobox', { name: /^Features people use/ }),
      'equal_split'
    );
    const memberPlace = screen.getByRole('spinbutton', { name: /^Member place, a month/ });
    await user.clear(memberPlace);
    await user.type(memberPlace, '5');
    await user.click(screen.getByRole('button', { name: 'Save for next month' }));

    expect(apiClient.patch).toHaveBeenCalledWith(SAVE_URL, {
      body: { ...POOL_SETTINGS, activityCostsPaidBy: 'equal_split', seatPriceMemberCredits: 5 },
    });
  });

  it('starts from the pending settings when a change is already waiting', () => {
    renderAdmin({
      ...ADMIN_BUDGET,
      billing: makeBilling({
        pending: {
          settings: settings({ shortfallPolicy: 'suspend', seatPriceAdminCredits: 9 }),
          from: '2026-11-05T00:00:00.000Z',
        },
      }),
    });

    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: /^When someone runs out/ }).value
    ).toBe('suspend');
    expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: /^Admin place/ }).value).toBe(
      '9'
    );
  });

  it('sends a blank place price as free', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ billing: { pending: null } });

    renderAdmin();
    await user.clear(screen.getByRole('spinbutton', { name: /^Viewer place/ }));
    await user.click(screen.getByRole('button', { name: 'Save for next month' }));

    expect(apiClient.patch).toHaveBeenCalledWith(SAVE_URL, {
      body: expect.objectContaining({ seatPriceViewerCredits: 0 }),
    });
  });

  it('sends nothing for a place price that is not a usable number, and says why', async () => {
    const user = userEvent.setup();

    renderAdmin();
    const input = screen.getByRole('spinbutton', { name: /^Member place/ });
    await user.clear(input);
    await user.type(input, '-2');
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(
      await screen.findByText('Each seat price must be a number of credits, or blank for free.')
    ).toBeInTheDocument();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it('only offers where allowances come from when the group pays by allowance', async () => {
    const user = userEvent.setup();

    renderAdmin();
    expect(
      screen.queryByRole('combobox', { name: /^Allowances come from/ })
    ).not.toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole('combobox', { name: /^Features people use/ }),
      'allowance'
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: /^Allowances come from/ }),
      'filled'
    );
    vi.mocked(apiClient.patch).mockResolvedValue({ billing: { pending: null } });
    await user.click(screen.getByRole('button', { name: 'Save for next month' }));

    expect(apiClient.patch).toHaveBeenCalledWith(SAVE_URL, {
      body: expect.objectContaining({
        activityCostsPaidBy: 'allowance',
        allowanceSource: 'filled',
      }),
    });
  });

  it('will not save "one admin pays" without choosing which admin', async () => {
    const user = userEvent.setup();

    renderAdmin();
    await user.selectOptions(screen.getByRole('combobox', { name: /^Running costs/ }), 'one_admin');
    await user.click(screen.getByRole('button', { name: 'Save for next month' }));

    expect(
      await screen.findByText('Choose which admin pays the running costs.')
    ).toBeInTheDocument();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it('offers only admins as the payer, and sends the one chosen', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ billing: { pending: null } });

    renderAdmin();
    await user.selectOptions(screen.getByRole('combobox', { name: /^Running costs/ }), 'one_admin');
    const payer = screen.getByRole('combobox', { name: 'Which admin pays' });
    const offered = within(payer)
      .getAllByRole('option')
      .map((option) => option.textContent);
    // Bailey is a member, so is not a choice; the viewer's own row reads "You".
    expect(offered).toContain('You');
    expect(offered).not.toContain('Bailey Chen');
    await user.selectOptions(payer, 'user_a');
    await user.click(screen.getByRole('button', { name: 'Save for next month' }));

    expect(apiClient.patch).toHaveBeenCalledWith(SAVE_URL, {
      body: expect.objectContaining({
        operationalCostsPaidBy: 'one_admin',
        operationalPayerUserId: 'user_a',
      }),
    });
  });

  it('clears the payer id when the running costs move away from one admin', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ billing: { pending: null } });

    renderAdmin(
      withSettings(ADMIN_BUDGET, {
        operationalCostsPaidBy: 'one_admin',
        operationalPayerUserId: 'user_a',
      })
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: /^Running costs/ }),
      'admins_split'
    );
    await user.click(screen.getByRole('button', { name: 'Save for next month' }));

    expect(apiClient.patch).toHaveBeenCalledWith(SAVE_URL, {
      body: expect.objectContaining({
        operationalCostsPaidBy: 'admins_split',
        operationalPayerUserId: null,
      }),
    });
  });

  it('shows when the saved change starts, using the date the server returned', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({
      billing: { pending: { from: '2026-11-05T00:00:00.000Z' } },
    });

    renderAdmin();
    expect(screen.queryByText(/A change starts on/)).not.toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole('combobox', { name: /^When someone runs out/ }),
      'suspend'
    );
    await user.click(screen.getByRole('button', { name: 'Save for next month' }));

    expect(await screen.findByText('A change starts on 5 November.')).toBeInTheDocument();
  });

  it('keeps nothing waiting on screen when the save fails', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockRejectedValue(new Error('refused'));

    renderAdmin();
    await user.selectOptions(
      screen.getByRole('combobox', { name: /^When someone runs out/ }),
      'suspend'
    );
    await user.click(screen.getByRole('button', { name: 'Save for next month' }));

    expect(await screen.findByText('refused')).toBeInTheDocument();
    expect(screen.queryByText(/A change starts on/)).not.toBeInTheDocument();
  });

  it('cancels a waiting change with discardPendingBilling and puts the form back to what is in force', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    renderAdmin({
      ...ADMIN_BUDGET,
      billing: makeBilling({
        pending: {
          settings: settings({ shortfallPolicy: 'suspend', seatPriceMemberCredits: 6 }),
          from: '2026-11-05T00:00:00.000Z',
        },
      }),
    });
    expect(screen.getByText('A change starts on 5 November.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel the change' }));

    expect(apiClient.patch).toHaveBeenCalledWith(SAVE_URL, {
      body: { discardPendingBilling: true },
    });
    await waitFor(() => expect(screen.queryByText(/A change starts on/)).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Cancel the change' })).not.toBeInTheDocument();
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: /^When someone runs out/ }).value
    ).toBe('debt');
    expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: /^Member place/ }).value).toBe(
      '0'
    );
  });

  it('leaves the waiting change in place when cancelling fails', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockRejectedValue(new Error('cancel refused'));

    renderAdmin({
      ...ADMIN_BUDGET,
      billing: makeBilling({
        pending: {
          settings: settings({ shortfallPolicy: 'suspend' }),
          from: '2026-11-05T00:00:00.000Z',
        },
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Cancel the change' }));

    expect(await screen.findByText('cancel refused')).toBeInTheDocument();
    expect(screen.getByText('A change starts on 5 November.')).toBeInTheDocument();
  });

  it('offers no cancel button when nothing is waiting', () => {
    renderAdmin();

    expect(screen.queryByRole('button', { name: 'Cancel the change' })).not.toBeInTheDocument();
  });
});
