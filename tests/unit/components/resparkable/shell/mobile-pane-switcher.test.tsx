/**
 * Unit Tests: MobilePaneSwitcher.
 *
 * `SparkeyPane`/`ActivityPane` are mocked to simple markers — their own
 * behavior is covered by their own test files. What matters here is the
 * switching contract itself: exactly one pane visible at a time, the
 * inactive ones hidden (via a `hidden` class) rather than unmounted so
 * in-progress state in `SparkeyPane`'s composer or `ActivityPane`'s
 * reviewed set survives a switch away and back, and the choice persists
 * across a remount (the same tab reopening after a reload).
 *
 * @see components/resparkable/shell/mobile-pane-switcher.tsx
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MobilePaneSwitcher } from '@/components/resparkable/shell/mobile-pane-switcher';

vi.mock('@/components/resparkable/sparkey/sparkey-pane', () => ({
  SparkeyPane: () => <div>sparkey pane marker</div>,
}));
vi.mock('@/components/resparkable/activity/activity-pane', () => ({
  ActivityPane: () => <div>activity pane marker</div>,
}));

function renderSwitcher() {
  return render(<MobilePaneSwitcher workspaceContent={<div>workspace pane marker</div>} />);
}

function hiddenAncestor(text: string): boolean {
  return screen.getByText(text).parentElement?.className.includes('hidden') ?? false;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('MobilePaneSwitcher', () => {
  it('defaults to the Workspace pane visible', () => {
    renderSwitcher();

    expect(hiddenAncestor('workspace pane marker')).toBe(false);
    expect(hiddenAncestor('sparkey pane marker')).toBe(true);
    expect(hiddenAncestor('activity pane marker')).toBe(true);
  });

  it('keeps every pane mounted regardless of which is visible', () => {
    renderSwitcher();

    expect(screen.getByText('sparkey pane marker')).toBeInTheDocument();
    expect(screen.getByText('workspace pane marker')).toBeInTheDocument();
    expect(screen.getByText('activity pane marker')).toBeInTheDocument();
  });

  it('switches visibility on tab click, without unmounting the others', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('tab', { name: 'Sparkey' }));

    expect(hiddenAncestor('sparkey pane marker')).toBe(false);
    expect(hiddenAncestor('workspace pane marker')).toBe(true);
    // Still in the DOM, just hidden — not remounted.
    expect(screen.getByText('activity pane marker')).toBeInTheDocument();
  });

  it('marks the active tab selected', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    expect(screen.getByRole('tab', { name: 'Workspace' })).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('tab', { name: 'Activity' }));

    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Workspace' })).toHaveAttribute(
      'aria-selected',
      'false'
    );
  });

  it('persists the chosen pane across a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderSwitcher();

    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    unmount();

    renderSwitcher();
    expect(hiddenAncestor('activity pane marker')).toBe(false);
  });

  describe('roving tabindex', () => {
    it('keeps only the active tab in the Tab-key order', () => {
      renderSwitcher();

      expect(screen.getByRole('tab', { name: 'Workspace' })).toHaveAttribute('tabindex', '0');
      expect(screen.getByRole('tab', { name: 'Sparkey' })).toHaveAttribute('tabindex', '-1');
      expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('tabindex', '-1');
    });

    it('ArrowRight moves focus and activates the next tab, wrapping past the end', async () => {
      const user = userEvent.setup();
      renderSwitcher();

      screen.getByRole('tab', { name: 'Activity' }).focus();
      await user.keyboard('{ArrowRight}');

      const sparkey = screen.getByRole('tab', { name: 'Sparkey' });
      expect(sparkey).toHaveFocus();
      expect(sparkey).toHaveAttribute('aria-selected', 'true');
      expect(hiddenAncestor('sparkey pane marker')).toBe(false);
    });

    it('ArrowLeft moves focus and activates the previous tab, wrapping before the start', async () => {
      const user = userEvent.setup();
      renderSwitcher();

      screen.getByRole('tab', { name: 'Sparkey' }).focus();
      await user.keyboard('{ArrowLeft}');

      const activity = screen.getByRole('tab', { name: 'Activity' });
      expect(activity).toHaveFocus();
      expect(activity).toHaveAttribute('aria-selected', 'true');
    });

    it('Home and End jump to the first and last tab', async () => {
      const user = userEvent.setup();
      renderSwitcher();

      screen.getByRole('tab', { name: 'Workspace' }).focus();
      await user.keyboard('{End}');
      expect(screen.getByRole('tab', { name: 'Activity' })).toHaveFocus();

      await user.keyboard('{Home}');
      expect(screen.getByRole('tab', { name: 'Sparkey' })).toHaveFocus();
    });

    it('ignores keys other than the arrow/Home/End set', async () => {
      const user = userEvent.setup();
      renderSwitcher();

      screen.getByRole('tab', { name: 'Workspace' }).focus();
      await user.keyboard('{Enter}');

      expect(screen.getByRole('tab', { name: 'Workspace' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    });
  });
});
