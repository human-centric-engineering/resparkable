/**
 * Unit Tests: `/s/[token]`, the public reader page (Release 2, phase 11).
 *
 * The only page in Resparkable that renders someone's notes to a viewer with
 * no session, so its failure paths matter more than its happy path. A bug
 * here is either a leak (showing something it shouldn't) or an oracle (a 404
 * that behaves differently for different reasons, letting a stranger infer
 * which tokens once existed).
 *
 * Test Coverage:
 * - A malformed token 404s WITHOUT touching `readPublicShare`: the shape
 *   check runs before the database is touched
 * - `readPublicShare` returning `null` 404s (unknown / revoked / expired /
 *   deleted-target all collapse to this one `null`, so one case covers all
 *   four, see the route's own test for why they must be indistinguishable)
 * - A payload renders the item title and body, and renders children when
 *   present
 * - `childrenTruncated` renders the "there are more" notice; `false` does not
 * - An archived item renders the Archived badge
 * - The exported `metadata` sets `robots.index === false` and
 *   `referrer === 'no-referrer'`, and its `title` never contains the item
 *   title: page titles reach browser history, tab lists and OS search
 *   indexes
 *
 * @see app/(public)/s/[token]/page.tsx
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { SharedItemView } from '@/lib/framework/resparkable/repo/shared-view';
import type { PublicSharePayload } from '@/lib/framework/resparkable/services/sharing';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/framework/resparkable/services/sharing', () => ({
  readPublicShare: vi.fn(),
}));

// `SharedMarkdown` is a `'use client'` react-markdown wrapper with its own
// dedicated suite (`shared-markdown.test.tsx`) covering image deferral and
// HTML stripping. Stubbing it here keeps this file's assertions about the
// PAGE's own logic (what it decides to render, and when) rather than
// re-testing the markdown renderer through it.
vi.mock('@/components/resparkable/share/shared-markdown', () => ({
  SharedMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { notFound } from 'next/navigation';
import { readPublicShare } from '@/lib/framework/resparkable/services/sharing';
import SharedItemPage, { metadata } from '@/app/(public)/s/[token]/page';

/** 32 base64url characters: the shape `shareTokenSchema` accepts. */
const VALID_TOKEN = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH';

function item(overrides: Partial<SharedItemView> = {}): SharedItemView {
  return {
    entityType: 'project',
    id: 'clh0000000000000000000001',
    title: 'Acme Redesign',
    body: 'The plan for Q3.',
    status: 'active',
    dueAt: null,
    horizon: null,
    archived: false,
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    tags: [],
    checklist: null,
    ...overrides,
  };
}

function payload(overrides: Partial<PublicSharePayload> = {}): PublicSharePayload {
  return {
    item: item(),
    children: [],
    childrenTruncated: false,
    includeTaskDetail: false,
    ...overrides,
  };
}

function renderPage(token: string) {
  return SharedItemPage({ params: Promise.resolve({ token }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readPublicShare).mockResolvedValue(payload());
});

describe('SharedItemPage', () => {
  it('404s a malformed token without touching readPublicShare', async () => {
    // Not 32 chars, so it fails shareTokenSchema. The comment on the page says the
    // shape check runs before the database is touched; this is what proves it.
    await expect(renderPage('short')).rejects.toThrow('NEXT_NOT_FOUND');

    expect(notFound).toHaveBeenCalled();
    expect(readPublicShare).not.toHaveBeenCalled();
  });

  it('404s when readPublicShare returns null', async () => {
    // Unknown, revoked, expired and deleted-target tokens are all the same
    // `null` from the service (see services/sharing.ts's readPublicShare
    // doc comment). One case here covers all four, because the page has no
    // branch that could tell them apart even if it wanted to.
    vi.mocked(readPublicShare).mockResolvedValue(null);

    await expect(renderPage(VALID_TOKEN)).rejects.toThrow('NEXT_NOT_FOUND');

    expect(notFound).toHaveBeenCalled();
  });

  it('renders the item title and body', async () => {
    vi.mocked(readPublicShare).mockResolvedValue(
      payload({ item: item({ title: 'Acme Redesign', body: 'The plan for Q3.' }) })
    );

    const element = await renderPage(VALID_TOKEN);
    render(element);

    expect(screen.getByRole('heading', { name: 'Acme Redesign' })).toBeInTheDocument();
    expect(screen.getByText('The plan for Q3.')).toBeInTheDocument();
  });

  it('renders children when present', async () => {
    vi.mocked(readPublicShare).mockResolvedValue(
      payload({
        children: [
          item({ entityType: 'task', id: 'clh0000000000000000000002', title: 'Write the brief' }),
        ],
      })
    );

    const element = await renderPage(VALID_TOKEN);
    render(element);

    expect(screen.getByText('Write the brief')).toBeInTheDocument();
  });

  it('shows the truncation notice when childrenTruncated is true', async () => {
    vi.mocked(readPublicShare).mockResolvedValue(
      payload({
        children: [item({ entityType: 'task', id: 'clh0000000000000000000003', title: 'Task A' })],
        childrenTruncated: true,
      })
    );

    const element = await renderPage(VALID_TOKEN);
    render(element);

    expect(screen.getByText(/there are more/i)).toBeInTheDocument();
  });

  it('does not show the truncation notice when childrenTruncated is false', async () => {
    vi.mocked(readPublicShare).mockResolvedValue(
      payload({
        children: [item({ entityType: 'task', id: 'clh0000000000000000000004', title: 'Task B' })],
        childrenTruncated: false,
      })
    );

    const element = await renderPage(VALID_TOKEN);
    render(element);

    expect(screen.queryByText(/there are more/i)).not.toBeInTheDocument();
  });

  it('renders the Archived badge for an archived item', async () => {
    vi.mocked(readPublicShare).mockResolvedValue(payload({ item: item({ archived: true }) }));

    const element = await renderPage(VALID_TOKEN);
    render(element);

    expect(screen.getByText('Archived')).toBeInTheDocument();
  });

  it('does not render the Archived badge for a non-archived item', async () => {
    vi.mocked(readPublicShare).mockResolvedValue(payload({ item: item({ archived: false }) }));

    const element = await renderPage(VALID_TOKEN);
    render(element);

    expect(screen.queryByText('Archived')).not.toBeInTheDocument();
  });
});

describe('SharedItemPage metadata', () => {
  it('sets robots.index to false and referrer to no-referrer', () => {
    expect(metadata.robots).toMatchObject({ index: false });
    expect(metadata.referrer).toBe('no-referrer');
  });

  it('does not name the shared item in the static title', () => {
    // Page titles reach browser history, tab lists and OS-level search
    // indexes. The title must be static and generic regardless of which item
    // is being shared, asserting it never contains a specific item's title
    // is the only way to pin that down; asserting it merely "is a string"
    // would pass even if a future change interpolated the title back in.
    expect(metadata.title).not.toContain('Acme Redesign');
    expect(typeof metadata.title).toBe('string');
  });
});
