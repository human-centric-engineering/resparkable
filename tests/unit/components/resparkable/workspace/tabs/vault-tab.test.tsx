/**
 * Unit Tests: VaultTab.
 *
 * VaultTab does no fetching of its own (this file's own header comment
 * explains why: both cards are already `'use client'` and self-fetching) —
 * its only job is to lay both cards out. `VaultExportCard`/`VaultImportCard`
 * are mocked to markers so this stays about VaultTab's composition, not
 * either card's own upload/download logic (covered by their own test files).
 *
 * @see components/resparkable/workspace/tabs/vault-tab.tsx
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { VaultTab } from '@/components/resparkable/workspace/tabs/vault-tab';

vi.mock('@/components/resparkable/vault/vault-export-card', () => ({
  VaultExportCard: () => <div data-testid="vault-export-card" />,
}));

vi.mock('@/components/resparkable/vault/vault-import-card', () => ({
  VaultImportCard: () => <div data-testid="vault-import-card" />,
}));

describe('VaultTab', () => {
  it('renders both the export and import cards', () => {
    render(<VaultTab />);

    expect(screen.getByTestId('vault-export-card')).toBeInTheDocument();
    expect(screen.getByTestId('vault-import-card')).toBeInTheDocument();
  });

  it('renders the export card before the import card', () => {
    render(<VaultTab />);

    const cards = screen.getAllByTestId(/vault-(export|import)-card/);
    expect(cards.map((el) => el.dataset.testid)).toEqual([
      'vault-export-card',
      'vault-import-card',
    ]);
  });
});
