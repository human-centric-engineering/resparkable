'use client';

/**
 * A group's credits: who pays, your own money in the group, the top-ups, and
 * the admin half.
 *
 * ## Two audiences, one component, and the split is the server's
 *
 * `budget.admin` is `null` for anybody who is not an admin, so there is nothing
 * here to hide with a role check: the admin controls' data never reaches a
 * member's browser. The role checks below only decide which controls to draw.
 * Where the money went is in the group's books (`group-books.tsx`), which every
 * member reads (phase 62).
 *
 * ## Who pays is shown to everyone, and changes wait for next month
 *
 * Every member sees how the group pays, in plain sentences, and any change an
 * admin has made that starts next month (decided 2026-10-19). Nobody is charged
 * differently without being able to see it first.
 *
 * ## The daily limit is not a productivity control
 *
 * Its help text says what it is for (a workflow left looping overnight) and not
 * what it could be misread as. §23.12 says an admin UI that presents it as "a
 * member is using too much" has misread it, so the copy never compares members.
 *
 * Not on the space-carrying client, for the reason `group-detail.tsx` gives.
 */

import * as React from 'react';

import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { formatDay } from '@/lib/framework/resparkable/ui/format-day';
import type {
  GroupBillingSettingsWire,
  GroupBudgetWire,
} from '@/lib/framework/resparkable/ui/payloads';

export interface GroupBudgetProps {
  groupId: string;
  budget: GroupBudgetWire;
  /** The caller's role, so a viewer is told why they cannot add credits. */
  yourRole: string;
  viewerUserId: string;
}

type FundingMode = GroupBudgetWire['fundingMode'];

/** The server's ceiling on any one amount (`validations.ts`). */
const MAX_CREDITS = 1_000_000;

/**
 * A blank box means "off" or "no limit"; anything else must be a number from
 * zero to the server's ceiling, so a value it would refuse is refused here in
 * plain words instead.
 */
function parseOptional(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_CREDITS ? parsed : undefined;
}

/**
 * The large-run share: blank is off, otherwise a whole number from 1 to 100,
 * which is what the server accepts. Anything else is refused here so a bad
 * percentage cannot take the low-balance setting down with it in one PATCH.
 */
function parsePercent(value: string): number | null | undefined {
  const parsed = parseOptional(value);
  if (parsed === null || parsed === undefined) return parsed;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : undefined;
}

/** A positive amount to move, or `undefined` with nothing sent. */
function parseAmount(value: string): number | undefined {
  const credits = Number(value);
  return Number.isFinite(credits) && credits > 0 && credits <= MAX_CREDITS ? credits : undefined;
}

/**
 * How the group pays, as sentences anyone in it can read. Pure, so the page
 * says exactly what the settings say and nothing else.
 */
export function describeWhoPays(
  settings: GroupBillingSettingsWire,
  payerName: string | null
): string[] {
  const lines: string[] = [];
  switch (settings.activityCostsPaidBy) {
    case 'pool':
      lines.push("When anyone uses a feature that costs credits, the group's shared balance pays.");
      break;
    case 'equal_split':
      lines.push(
        'When anyone uses a feature that costs credits, the cost is shared equally between every admin and member, from each person’s own balance in the group.'
      );
      break;
    case 'allowance':
      lines.push(
        settings.allowanceSource === 'carved'
          ? "Each person can use up to their monthly allowance from the group's shared balance. Unused allowance carries over."
          : 'Each person pays for what they use from their own balance in the group.'
      );
      break;
  }
  switch (settings.operationalCostsPaidBy) {
    case 'pool':
      lines.push("The shared balance pays the group's running costs, such as the weekly summary.");
      break;
    case 'one_admin':
      lines.push(
        `${payerName ?? 'One of the admins'} pays the group's running costs, such as the weekly summary.`
      );
      break;
    case 'admins_split':
      lines.push("The admins share the group's running costs, such as the weekly summary.");
      break;
  }
  const { seatPriceAdminCredits: admin, seatPriceMemberCredits: member } = settings;
  const viewer = settings.seatPriceViewerCredits;
  if (admin > 0 || member > 0 || viewer > 0) {
    lines.push(
      `A place in the group costs ${member} credits a month for a member, ${admin} for an admin and ${viewer} for a viewer, paid from your own balance in the group. The month you join in is free.`
    );
  }
  lines.push(
    settings.shortfallPolicy === 'debt'
      ? 'If your balance in the group runs out, you can carry on while the shared balance can cover you, and you pay it back the next time you add credits.'
      : 'If your balance in the group goes below zero, you cannot use features that cost credits until you add enough to cover it.'
  );
  return lines;
}

/** Whether these settings ever charge a member's own balance in the group. */
function usesOwnBalances(settings: GroupBillingSettingsWire): boolean {
  return (
    settings.activityCostsPaidBy === 'equal_split' ||
    (settings.activityCostsPaidBy === 'allowance' && settings.allowanceSource === 'filled') ||
    settings.operationalCostsPaidBy !== 'pool' ||
    settings.seatPriceAdminCredits > 0 ||
    settings.seatPriceMemberCredits > 0 ||
    settings.seatPriceViewerCredits > 0
  );
}

export function GroupBudget({
  groupId,
  budget,
  yourRole,
  viewerUserId,
}: GroupBudgetProps): React.ReactElement {
  const [balance, setBalance] = React.useState(budget.balanceCredits);
  const [personal, setPersonal] = React.useState(budget.yourPersonalBalanceCredits);
  const [own, setOwn] = React.useState(budget.you.balanceCredits);
  // A `router.refresh()` brings new figures. Follow them without remounting,
  // so nothing an admin is typing below is lost.
  React.useEffect(() => setBalance(budget.balanceCredits), [budget.balanceCredits]);
  React.useEffect(
    () => setPersonal(budget.yourPersonalBalanceCredits),
    [budget.yourPersonalBalanceCredits]
  );
  React.useEffect(() => setOwn(budget.you.balanceCredits), [budget.you.balanceCredits]);
  const [amount, setAmount] = React.useState('');
  // Your own limit, which an admin can change for themselves in the table below.
  const [yourCap, setYourCap] = React.useState(budget.you.dailyCreditCap);
  React.useEffect(() => setYourCap(budget.you.dailyCreditCap), [budget.you.dailyCreditCap]);
  const { state, message, run } = useSaveStatus();

  const { settings, pending, timeZone } = budget.billing;
  // Any allowance is about the person, so a carved one shows here too even
  // though it is a limit on the shared balance rather than money of their own.
  const showOwn =
    usesOwnBalances(settings) ||
    settings.activityCostsPaidBy === 'allowance' ||
    (pending !== null && usesOwnBalances(pending.settings)) ||
    own !== 0;

  async function topUp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const credits = parseAmount(amount);
    if (credits === undefined) {
      await run(() =>
        Promise.reject(new Error(`Add between 0 and ${MAX_CREDITS.toLocaleString()} credits.`))
      );
      return;
    }

    const box: { result: { balanceCredits: number } | null } = { result: null };
    const ok = await run(async () => {
      box.result = await apiClient.post(RESPARKABLE_API.groupTopUp(groupId), {
        body: { credits },
      });
    });
    if (ok && box.result) {
      setBalance(box.result.balanceCredits);
      setPersonal((prev) => Math.round((prev - credits) * 100) / 100);
      setAmount('');
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
          Credits
          <FieldHelp title="The group's credits">
            <p>
              The group has a shared balance, and each person can also keep a balance of their own
              in the group. Which one pays for what is set by the group&apos;s admins, and is
              written out below.
            </p>
            <p>
              Nobody&apos;s own credits are ever taken to pay for the group without their say.
              Credits only move from your own balance when you add them, or when you have set up an
              automatic top-up yourself.
            </p>
            <p>Viewers never use features that cost credits.</p>
          </FieldHelp>
        </h3>
        <p className="text-sm">
          The group&apos;s shared balance is <strong>{balance}</strong> credits.
        </p>
        {yourCap !== null && (
          <p className="text-muted-foreground mt-1 text-xs">
            You can use up to {yourCap} credits here in any 24 hours. You have used{' '}
            {budget.you.spentLastDayCredits}.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-medium">How the group pays</h4>
        <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-4 text-xs">
          {describeWhoPays(settings, budget.billing.operationalPayerName).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {pending && (
          <div className="border-border/60 mt-2 rounded-md border px-3 py-2 text-xs">
            <p className="font-medium">From {formatDay(pending.from, timeZone)}:</p>
            <ul className="text-muted-foreground mt-1 flex list-disc flex-col gap-1 pl-4">
              {describeWhoPays(pending.settings, null).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {showOwn && (
        <YourMoney
          groupId={groupId}
          budget={budget}
          own={own}
          personal={personal}
          onOwnChanged={setOwn}
          onPersonalChanged={setPersonal}
        />
      )}

      {budget.canTopUp ? (
        <form className="flex items-end gap-2" onSubmit={(event) => void topUp(event)}>
          <div className="flex-1">
            <Label htmlFor="group-top-up" className="mb-1 flex items-center gap-1.5 text-xs">
              Add credits to the shared balance
              <FieldHelp title="Adding to the shared balance">
                <p>
                  The credits come out of your own balance and go to the group. You have {personal}{' '}
                  of your own.
                </p>
                <p>
                  Once added, they are the group&apos;s. If the group is ever deleted, what is left
                  is shared back in proportion to what each person put in.
                </p>
              </FieldHelp>
            </Label>
            <Input
              id="group-top-up"
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="10"
            />
          </div>
          <Button type="submit" size="sm" disabled={!amount.trim() || state === 'saving'}>
            Add
          </Button>
        </form>
      ) : (
        <p className="text-muted-foreground text-xs">
          {yourRole === 'viewer'
            ? 'Viewers do not add to the shared balance.'
            : 'In this group, admins add to the shared balance.'}
        </p>
      )}

      <SaveStatus state={state} message={message} />

      {budget.admin && (
        <GroupBudgetAdmin
          groupId={groupId}
          fundingMode={budget.fundingMode}
          admin={budget.admin}
          billing={budget.billing}
          viewerUserId={viewerUserId}
          onCapSaved={(userId, cap) => {
            if (userId === viewerUserId) setYourCap(cap);
          }}
        />
      )}
    </section>
  );
}

/** The caller's own money in the group: balance, allowance, adding, automatic top-up. */
function YourMoney({
  groupId,
  budget,
  own,
  personal,
  onOwnChanged,
  onPersonalChanged,
}: {
  groupId: string;
  budget: GroupBudgetWire;
  own: number;
  personal: number;
  onOwnChanged: (balance: number) => void;
  onPersonalChanged: (update: (prev: number) => number) => void;
}): React.ReactElement {
  const { you, billing } = budget;
  const [amount, setAmount] = React.useState('');
  const [autoTopUp, setAutoTopUp] = React.useState(
    you.autoTopUpMonthlyCredits === null ? '' : String(you.autoTopUpMonthlyCredits)
  );
  const { state, message, run } = useSaveStatus();
  const carved =
    billing.settings.activityCostsPaidBy === 'allowance' &&
    billing.settings.allowanceSource === 'carved';
  const filled =
    billing.settings.activityCostsPaidBy === 'allowance' &&
    billing.settings.allowanceSource === 'filled';

  async function addToOwn(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const credits = parseAmount(amount);
    if (credits === undefined) {
      await run(() =>
        Promise.reject(new Error(`Add between 0 and ${MAX_CREDITS.toLocaleString()} credits.`))
      );
      return;
    }
    const box: { result: { memberBalanceCredits: number } | null } = { result: null };
    const ok = await run(async () => {
      box.result = await apiClient.post(RESPARKABLE_API.groupTopUp(groupId), {
        body: { credits, to: 'me' },
      });
    });
    if (ok && box.result) {
      onOwnChanged(box.result.memberBalanceCredits);
      onPersonalChanged((prev) => Math.round((prev - credits) * 100) / 100);
      setAmount('');
    }
  }

  async function saveAutoTopUp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = autoTopUp.trim();
    const autoTopUpMonthlyCredits = trimmed === '' ? null : parseAmount(trimmed);
    if (autoTopUpMonthlyCredits === undefined) {
      await run(() =>
        Promise.reject(
          new Error('An automatic top-up must be a number of credits, or blank for off.')
        )
      );
      return;
    }
    await run(() =>
      apiClient.patch(RESPARKABLE_API.groupOwnBudget(groupId), {
        body: { autoTopUpMonthlyCredits },
      })
    );
  }

  return (
    <div className="border-border/60 flex flex-col gap-3 rounded-md border px-3 py-3">
      <div>
        <p className="text-sm">
          Your balance in this group is <strong>{own}</strong> credits.
        </p>
        {own < 0 && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            {you.suspended
              ? `You owe the group ${-own} credits. Add at least that much to use features that cost credits again.`
              : `You owe the group ${-own} credits. Your next top-up pays it back first.`}
          </p>
        )}
        {carved && (
          <p className="text-muted-foreground mt-1 text-xs">
            Allowance left from the shared balance: {you.allowanceRemainingCredits}
            {you.allowanceCredits !== null && ` (${you.allowanceCredits} is added each month)`}.
          </p>
        )}
        {filled && you.allowanceCredits !== null && (
          <p className="text-muted-foreground mt-1 text-xs">
            You can spend up to {you.allowanceCredits} of your balance here each month.
          </p>
        )}
      </div>

      <form className="flex items-end gap-2" onSubmit={(event) => void addToOwn(event)}>
        <div className="flex-1">
          <Label htmlFor="group-own-top-up" className="mb-1 flex items-center gap-1.5 text-xs">
            Add credits to your balance in this group
            <FieldHelp title="Your balance in the group">
              <p>
                The credits come out of your own balance and stay yours. You have {personal} of your
                own.
              </p>
              <p>Whatever is left comes back to you if you leave the group or it is deleted.</p>
            </FieldHelp>
          </Label>
          <Input
            id="group-own-top-up"
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="10"
          />
        </div>
        <Button type="submit" size="sm" disabled={!amount.trim() || state === 'saving'}>
          Add
        </Button>
      </form>

      <form className="flex items-end gap-2" onSubmit={(event) => void saveAutoTopUp(event)}>
        <div className="flex-1">
          <Label htmlFor="group-auto-top-up" className="mb-1 flex items-center gap-1.5 text-xs">
            Top up automatically, up to this much a month
            <FieldHelp title="Automatic top-up">
              <p>
                When your balance in the group runs out, up to this many credits move from your own
                balance to keep you going. Never more than this in a month, and never more than you
                have.
              </p>
              <p>
                Only you can set this. Leave it blank to switch it off. You have used{' '}
                {you.autoTopUpUsedThisMonthCredits} this month.
              </p>
            </FieldHelp>
          </Label>
          <Input
            id="group-auto-top-up"
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={autoTopUp}
            onChange={(event) => setAutoTopUp(event.target.value)}
            placeholder="Off"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={state === 'saving'}>
          Save
        </Button>
      </form>

      <SaveStatus state={state} message={message} />
    </div>
  );
}

function GroupBudgetAdmin({
  groupId,
  fundingMode: initialMode,
  admin,
  billing,
  viewerUserId,
  onCapSaved,
}: {
  groupId: string;
  fundingMode: FundingMode;
  admin: NonNullable<GroupBudgetWire['admin']>;
  billing: GroupBudgetWire['billing'];
  viewerUserId: string;
  onCapSaved: (userId: string, cap: number | null) => void;
}): React.ReactElement {
  const [fundingMode, setFundingMode] = React.useState<FundingMode>(initialMode);
  const [lowBalance, setLowBalance] = React.useState(
    admin.lowBalanceAlertCredits === null ? '' : String(admin.lowBalanceAlertCredits)
  );
  const [largeRun, setLargeRun] = React.useState(
    admin.largeRunAlertPercent === null ? '' : String(admin.largeRunAlertPercent)
  );
  const [caps, setCaps] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      admin.members.map((member) => [
        member.userId,
        member.dailyCreditCap === null ? '' : String(member.dailyCreditCap),
      ])
    )
  );
  const [allowances, setAllowances] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      admin.members.map((member) => [
        member.userId,
        member.allowanceCredits === null ? '' : String(member.allowanceCredits),
      ])
    )
  );
  // What the server last accepted for each box, to tell a changed box from one
  // that was only visited.
  const savedCaps = React.useRef<Record<string, string>>(caps);
  const savedAllowances = React.useRef<Record<string, string>>(allowances);
  const { state, message, run } = useSaveStatus();
  const draftSource = billing.pending?.settings ?? billing.settings;
  const showAllowances =
    billing.settings.activityCostsPaidBy === 'allowance' ||
    draftSource.activityCostsPaidBy === 'allowance';

  async function changeMode(next: string): Promise<void> {
    if (next !== 'self_funded' && next !== 'member_contributions') return;
    const previous = fundingMode;
    setFundingMode(next);
    const ok = await run(() =>
      apiClient.patch(RESPARKABLE_API.groupBudget(groupId), { body: { fundingMode: next } })
    );
    if (!ok) setFundingMode(previous);
  }

  /** Say why nothing was saved, in the same status line a save uses. */
  function refuse(message: string): Promise<boolean> {
    return run(() => Promise.reject(new Error(message)));
  }

  async function saveAlerts(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const lowBalanceAlertCredits = parseOptional(lowBalance);
    const largeRunAlertPercent = parsePercent(largeRun);
    if (lowBalanceAlertCredits === undefined) {
      await refuse('The low balance alert must be a number of credits, or blank for off.');
      return;
    }
    if (largeRunAlertPercent === undefined) {
      await refuse('The large run alert must be a whole number from 1 to 100, or blank for off.');
      return;
    }
    await run(() =>
      apiClient.patch(RESPARKABLE_API.groupBudget(groupId), {
        body: { lowBalanceAlertCredits, largeRunAlertPercent },
      })
    );
  }

  async function saveCap(userId: string): Promise<void> {
    const typed = caps[userId] ?? '';
    // Leaving a box without changing it saves nothing, so tabbing through the
    // table neither sends a request per row nor writes back a value another
    // admin has since changed.
    if (typed.trim() === (savedCaps.current[userId] ?? '').trim()) return;
    const dailyCreditCap = parseOptional(typed);
    if (dailyCreditCap === undefined) {
      await refuse('A daily limit must be a number of credits, or blank for no limit.');
      return;
    }
    const ok = await run(() =>
      apiClient.patch(RESPARKABLE_API.groupMemberCap(groupId, userId), {
        body: { dailyCreditCap },
      })
    );
    if (ok) {
      savedCaps.current = { ...savedCaps.current, [userId]: typed };
      onCapSaved(userId, dailyCreditCap);
    }
  }

  async function saveAllowance(userId: string): Promise<void> {
    const typed = allowances[userId] ?? '';
    if (typed.trim() === (savedAllowances.current[userId] ?? '').trim()) return;
    const allowanceCredits = parseOptional(typed);
    if (allowanceCredits === undefined) {
      await refuse('A monthly allowance must be a number of credits, or blank for none.');
      return;
    }
    const ok = await run(() =>
      apiClient.patch(RESPARKABLE_API.groupMemberCap(groupId, userId), {
        body: { allowanceCredits },
      })
    );
    if (ok) savedAllowances.current = { ...savedAllowances.current, [userId]: typed };
  }

  const nameOf = (member: (typeof admin.members)[number]): string =>
    member.userId === viewerUserId ? 'You' : (member.name ?? 'A member');

  return (
    <div className="border-border/60 flex flex-col gap-4 rounded-md border px-3 py-3">
      <p className="text-muted-foreground text-[11px]">Only admins see this part.</p>

      <div className="flex items-center gap-2">
        <Label htmlFor="group-funding-mode" className="flex items-center gap-1.5 text-xs">
          Who adds to the shared balance
          <FieldHelp title="Who adds to the shared balance">
            <p>
              <strong>Admins only</strong>: admins add credits from their own balance.
            </p>
            <p>
              <strong>Any member</strong>: members can add credits from their own balance too.
              Viewers never can.
            </p>
            <p>
              Either way, adding credits is something a person does on purpose. Nobody&apos;s own
              credits are ever taken to pay for the group without their say.
            </p>
          </FieldHelp>
        </Label>
        <Select value={fundingMode} onValueChange={(next) => void changeMode(next)}>
          <SelectTrigger id="group-funding-mode" className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="self_funded">Admins only</SelectItem>
            <SelectItem value="member_contributions">Any member</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <WhoPaysForm
        groupId={groupId}
        billing={billing}
        admins={admin.members.filter((member) => member.role === 'admin')}
        nameOf={nameOf}
      />

      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void saveAlerts(event)}>
        <div>
          <Label htmlFor="group-low-balance" className="mb-1 flex items-center gap-1.5 text-xs">
            Email me when the shared balance falls to
            <FieldHelp title="Low balance alert">
              <p>
                Admins get an email when the group&apos;s shared balance falls to this many credits
                or below. Leave it blank to switch it off.
              </p>
              <p>It is sent once as the balance crosses the line, not after every run.</p>
            </FieldHelp>
          </Label>
          <Input
            id="group-low-balance"
            className="w-32"
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={lowBalance}
            onChange={(event) => setLowBalance(event.target.value)}
            placeholder="Off"
          />
        </div>
        <div>
          <Label htmlFor="group-large-run" className="mb-1 flex items-center gap-1.5 text-xs">
            or one run uses more than (%)
            <FieldHelp title="Large run alert">
              <p>
                Admins get an email when a single run uses more than this share of the credits that
                were left before it. Leave it blank to switch it off.
              </p>
            </FieldHelp>
          </Label>
          <Input
            id="group-large-run"
            className="w-24"
            type="number"
            min={1}
            max={100}
            step={1}
            inputMode="numeric"
            value={largeRun}
            onChange={(event) => setLargeRun(event.target.value)}
            placeholder="Off"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={state === 'saving'}>
          Save alerts
        </Button>
      </form>

      <div>
        <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium">
          Limits by person
          <FieldHelp title="Daily limit and monthly allowance">
            <p>
              A <strong>daily limit</strong> caps what one person can spend in the group in any 24
              hours. It is a safety net for something left running by mistake, such as a workflow
              that loops overnight.
            </p>
            <p>
              A <strong>monthly allowance</strong> is how much of the shared balance a person can
              use each month, or, when people pay from their own balance, the most they can spend in
              a month. It only applies when the group pays by allowance.
            </p>
            <p>
              Leave a box blank for none. Each person sees their own limits and nobody else&apos;s.
            </p>
          </FieldHelp>
        </h4>
        <table className="w-full text-xs">
          <thead className="text-muted-foreground text-left">
            <tr>
              <th className="py-1 font-normal">Person</th>
              <th className="py-1 font-normal">Daily limit</th>
              {showAllowances && <th className="py-1 font-normal">Monthly allowance</th>}
            </tr>
          </thead>
          <tbody>
            {admin.members.map((member) => (
              <tr key={member.userId} className="border-border/60 border-t">
                <td className="max-w-40 truncate py-1.5">{nameOf(member)}</td>
                <td className="py-1.5">
                  {member.role === 'viewer' ? (
                    <span className="text-muted-foreground">Viewer</span>
                  ) : (
                    <Input
                      className="h-7 w-24 text-xs"
                      type="number"
                      min={0}
                      step="any"
                      inputMode="decimal"
                      aria-label={`Daily limit for ${nameOf(member)}`}
                      value={caps[member.userId] ?? ''}
                      onChange={(event) =>
                        setCaps((prev) => ({ ...prev, [member.userId]: event.target.value }))
                      }
                      onBlur={() => void saveCap(member.userId)}
                      placeholder="None"
                    />
                  )}
                </td>
                {showAllowances && (
                  <td className="py-1.5">
                    {member.role === 'viewer' ? (
                      <span className="text-muted-foreground">Viewer</span>
                    ) : (
                      <Input
                        className="h-7 w-24 text-xs"
                        type="number"
                        min={0}
                        step="any"
                        inputMode="decimal"
                        aria-label={`Monthly allowance for ${nameOf(member)}`}
                        value={allowances[member.userId] ?? ''}
                        onChange={(event) =>
                          setAllowances((prev) => ({
                            ...prev,
                            [member.userId]: event.target.value,
                          }))
                        }
                        onBlur={() => void saveAllowance(member.userId)}
                        placeholder="None"
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SaveStatus state={state} message={message} />
    </div>
  );
}

/**
 * The admin's who-pays settings. Saved together, and never at once: the server
 * schedules them for the start of the group's next month and every member sees
 * the change waiting.
 */
function WhoPaysForm({
  groupId,
  billing,
  admins,
  nameOf,
}: {
  groupId: string;
  billing: GroupBudgetWire['billing'];
  admins: NonNullable<GroupBudgetWire['admin']>['members'];
  nameOf: (member: NonNullable<GroupBudgetWire['admin']>['members'][number]) => string;
}): React.ReactElement {
  const start = billing.pending?.settings ?? billing.settings;
  const [draft, setDraft] = React.useState<GroupBillingSettingsWire>(start);
  const [seats, setSeats] = React.useState({
    admin: String(start.seatPriceAdminCredits),
    member: String(start.seatPriceMemberCredits),
    viewer: String(start.seatPriceViewerCredits),
  });
  const [pendingFrom, setPendingFrom] = React.useState(billing.pending?.from ?? null);
  const { state, message, run } = useSaveStatus();

  function set<K extends keyof GroupBillingSettingsWire>(
    key: K,
    value: GroupBillingSettingsWire[K]
  ): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const seatPriceAdminCredits = parseOptional(seats.admin);
    const seatPriceMemberCredits = parseOptional(seats.member);
    const seatPriceViewerCredits = parseOptional(seats.viewer);
    if (
      seatPriceAdminCredits === undefined ||
      seatPriceMemberCredits === undefined ||
      seatPriceViewerCredits === undefined
    ) {
      await run(() =>
        Promise.reject(new Error('Each seat price must be a number of credits, or blank for free.'))
      );
      return;
    }
    if (draft.operationalCostsPaidBy === 'one_admin' && !draft.operationalPayerUserId) {
      await run(() => Promise.reject(new Error('Choose which admin pays the running costs.')));
      return;
    }
    const box: { from: string | null } = { from: null };
    const ok = await run(async () => {
      const result: { billing?: { pending: { from: string } | null } } = await apiClient.patch(
        RESPARKABLE_API.groupBudget(groupId),
        {
          body: {
            ...draft,
            operationalPayerUserId:
              draft.operationalCostsPaidBy === 'one_admin' ? draft.operationalPayerUserId : null,
            seatPriceAdminCredits: seatPriceAdminCredits ?? 0,
            seatPriceMemberCredits: seatPriceMemberCredits ?? 0,
            seatPriceViewerCredits: seatPriceViewerCredits ?? 0,
          },
        }
      );
      box.from = result.billing?.pending?.from ?? null;
    });
    if (ok) setPendingFrom(box.from);
  }

  async function discard(): Promise<void> {
    const ok = await run(() =>
      apiClient.patch(RESPARKABLE_API.groupBudget(groupId), {
        body: { discardPendingBilling: true },
      })
    );
    if (ok) {
      setPendingFrom(null);
      setDraft(billing.settings);
      setSeats({
        admin: String(billing.settings.seatPriceAdminCredits),
        member: String(billing.settings.seatPriceMemberCredits),
        viewer: String(billing.settings.seatPriceViewerCredits),
      });
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void save(event)}>
      <h4 className="flex items-center gap-1.5 text-xs font-medium">
        Who pays
        <FieldHelp title="Who pays">
          <p>
            Changes start at the beginning of the group&apos;s next month, on{' '}
            {formatDay(billing.nextMonthStartsAt, billing.timeZone)}, so nobody is charged
            differently without warning. Everyone in the group can see a change before it starts.
          </p>
        </FieldHelp>
      </h4>

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="group-activity-payer" className="flex items-center gap-1.5 text-xs">
          Features people use
          <FieldHelp title="Who pays for what people use">
            <p>
              <strong>The shared balance</strong>: the group pays, whoever uses it.
            </p>
            <p>
              <strong>Shared equally</strong>: each cost is divided equally between every admin and
              member, from each person&apos;s own balance in the group.
            </p>
            <p>
              <strong>Monthly allowance</strong>: each person has an allowance, which you set below.
            </p>
          </FieldHelp>
        </Label>
        <Select
          value={draft.activityCostsPaidBy}
          onValueChange={(next) => {
            if (next === 'pool' || next === 'equal_split' || next === 'allowance') {
              set('activityCostsPaidBy', next);
            }
          }}
        >
          <SelectTrigger id="group-activity-payer" className="h-8 w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pool">The shared balance</SelectItem>
            <SelectItem value="equal_split">Shared equally</SelectItem>
            <SelectItem value="allowance">Monthly allowance</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {draft.activityCostsPaidBy === 'allowance' && (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="group-allowance-source" className="flex items-center gap-1.5 text-xs">
            Allowances come from
            <FieldHelp title="Where allowances come from">
              <p>
                <strong>The shared balance</strong>: each person can use up to their allowance of
                the group&apos;s credits each month. Unused allowance carries over.
              </p>
              <p>
                <strong>Each person&apos;s own balance</strong>: people pay for what they use from
                credits they put in the group themselves. The allowance is then the most they can
                spend in a month.
              </p>
            </FieldHelp>
          </Label>
          <Select
            value={draft.allowanceSource}
            onValueChange={(next) => {
              if (next === 'carved' || next === 'filled') set('allowanceSource', next);
            }}
          >
            <SelectTrigger id="group-allowance-source" className="h-8 w-48 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="carved">The shared balance</SelectItem>
              <SelectItem value="filled">Each person&apos;s own balance</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="group-operational-payer" className="flex items-center gap-1.5 text-xs">
          Running costs
          <FieldHelp title="Who pays the running costs">
            <p>Running costs are things nobody in particular starts, such as the weekly summary.</p>
            <p>
              If the admin you choose leaves the group or stops being an admin, the shared balance
              pays instead and the admins are told.
            </p>
          </FieldHelp>
        </Label>
        <Select
          value={draft.operationalCostsPaidBy}
          onValueChange={(next) => {
            if (next === 'pool' || next === 'one_admin' || next === 'admins_split') {
              set('operationalCostsPaidBy', next);
            }
          }}
        >
          <SelectTrigger id="group-operational-payer" className="h-8 w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pool">The shared balance</SelectItem>
            <SelectItem value="one_admin">One admin</SelectItem>
            <SelectItem value="admins_split">The admins, shared</SelectItem>
          </SelectContent>
        </Select>
        {draft.operationalCostsPaidBy === 'one_admin' && (
          <Select
            value={draft.operationalPayerUserId ?? ''}
            onValueChange={(next) => set('operationalPayerUserId', next)}
          >
            <SelectTrigger aria-label="Which admin pays" className="h-8 w-40 text-xs">
              <SelectValue placeholder="Choose an admin" />
            </SelectTrigger>
            <SelectContent>
              {admins.map((member) => (
                <SelectItem key={member.userId} value={member.userId}>
                  {nameOf(member)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="group-shortfall" className="flex items-center gap-1.5 text-xs">
          When someone runs out
          <FieldHelp title="When someone's balance runs out">
            <p>
              <strong>They can owe the group</strong>: they carry on while the shared balance can
              cover them, and pay it back the next time they add credits.
            </p>
            <p>
              <strong>They pause</strong>: they cannot use features that cost credits until they add
              enough. They can still read and write everything else.
            </p>
          </FieldHelp>
        </Label>
        <Select
          value={draft.shortfallPolicy}
          onValueChange={(next) => {
            if (next === 'debt' || next === 'suspend') set('shortfallPolicy', next);
          }}
        >
          <SelectTrigger id="group-shortfall" className="h-8 w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="debt">They can owe the group</SelectItem>
            <SelectItem value="suspend">They pause</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {(['member', 'admin', 'viewer'] as const).map((role) => (
          <div key={role}>
            <Label
              htmlFor={`group-seat-${role}`}
              className="mb-1 flex items-center gap-1.5 text-xs"
            >
              {role === 'member' ? 'Member' : role === 'admin' ? 'Admin' : 'Viewer'} place, a month
              {role === 'member' && (
                <FieldHelp title="The price of a place">
                  <p>
                    What a place in the group costs each month, by role. It is paid into the shared
                    balance from each person&apos;s own balance in the group. The month someone
                    joins in is free.
                  </p>
                  <p>Leave it at 0, or blank, for free.</p>
                </FieldHelp>
              )}
            </Label>
            <Input
              id={`group-seat-${role}`}
              className="w-24"
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={seats[role]}
              onChange={(event) => setSeats((prev) => ({ ...prev, [role]: event.target.value }))}
              placeholder="0"
            />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant="outline" disabled={state === 'saving'}>
          Save for next month
        </Button>
        {pendingFrom && (
          <>
            <span className="text-muted-foreground text-xs">
              A change starts on {formatDay(pendingFrom, billing.timeZone)}.
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={state === 'saving'}
              onClick={() => void discard()}
            >
              Cancel the change
            </Button>
          </>
        )}
      </div>

      <SaveStatus state={state} message={message} />
    </form>
  );
}
