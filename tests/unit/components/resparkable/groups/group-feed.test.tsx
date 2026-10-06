// @vitest-environment happy-dom

/**
 * Component Tests: the group activity feed (phase 59, §23.10).
 *
 * Includes 13m, which is deliberately a rendering test: the rows are all
 * there and always were, and the rule is about what is built on top of them.
 * A feed is a list of names next to actions, which is what a monitor looks
 * like; these assert it reads as a record of items instead.
 *
 * @see components/resparkable/groups/group-feed.tsx
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/components/resparkable/groups/use-active-group-members', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/components/resparkable/groups/use-active-group-members')
  >()),
  useActiveGroupMembers: vi.fn(() => [
    {
      userId: 'user_sam',
      name: 'Sam',
      role: 'member',
      joinedAt: '2026-09-01T00:00:00.000Z',
      requestedAt: null,
    },
    {
      userId: 'user_priya',
      name: 'Priya',
      role: 'member',
      joinedAt: '2026-09-02T00:00:00.000Z',
      requestedAt: null,
    },
  ]),
}));

import { GroupFeed } from '@/components/resparkable/groups/group-feed';

interface Line {
  id: string;
  title: string;
  actorName: string;
  createdAt: string;
}

function page(lines: Line[], nextCursor: string | null = null, seenAt: string | null = null) {
  return {
    success: true,
    data: {
      items: lines.map((line) => ({
        id: line.id,
        kind: 'created',
        entityType: 'task',
        entityId: `task_${line.id}`,
        title: line.title,
        actorName: line.actorName,
        byYou: false,
        system: false,
        createdAt: line.createdAt,
      })),
      nextCursor,
      seenAt,
    },
  };
}

function ok(body: unknown, etag = 'W/"a"'): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { ETag: etag } });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/resparkable?space=spc_g');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The URL a fetch was called with, whatever form it was given in. */
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function feedCalls(): string[] {
  return fetchMock.mock.calls
    .map(([input]) => urlOf(input))
    .filter((url) => url.includes('/feed') && !url.includes('/feed/seen'));
}

describe('GroupFeed', () => {
  it('leads each line with the item, and gives the person as attribution', async () => {
    fetchMock.mockResolvedValue(
      ok(
        page([
          {
            id: '1',
            title: 'Chapter 4 notes',
            actorName: 'Sam',
            createdAt: '2026-10-01T10:00:00.000Z',
          },
        ])
      )
    );
    render(<GroupFeed />);

    const item = await screen.findByRole('listitem');
    expect(item.textContent?.startsWith('Chapter 4 notes')).toBe(true);
    expect(item).toHaveTextContent('added by Sam');
  });

  it('marks the feed seen once, after the first load', async () => {
    fetchMock.mockResolvedValue(
      ok(page([{ id: '1', title: 'A', actorName: 'Sam', createdAt: '2026-10-01T10:00:00.000Z' }]))
    );
    render(<GroupFeed />);
    await screen.findByRole('listitem');

    await waitFor(() => {
      const seen = fetchMock.mock.calls.filter(([input]) => urlOf(input).includes('/feed/seen'));
      expect(seen).toHaveLength(1);
      expect(seen[0][1]).toMatchObject({ method: 'POST' });
    });
  });

  it('styles lines that arrived since the reader last looked as new, and says so to a screen reader', async () => {
    fetchMock.mockResolvedValue(
      ok(
        page(
          [
            { id: 'new', title: 'Fresh', actorName: 'Sam', createdAt: '2026-10-02T10:00:00.000Z' },
            { id: 'old', title: 'Stale', actorName: 'Sam', createdAt: '2026-09-28T10:00:00.000Z' },
          ],
          null,
          '2026-10-01T00:00:00.000Z'
        )
      )
    );
    render(<GroupFeed />);

    const [fresh, stale] = await screen.findAllByRole('listitem');
    expect(fresh).toHaveTextContent('new since you last looked');
    expect(stale).not.toHaveTextContent('new since you last looked');
  });

  it('shows older lines on request, from the cursor', async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok(
          page(
            [{ id: '1', title: 'Newer', actorName: 'Sam', createdAt: '2026-10-02T10:00:00.000Z' }],
            '2026-10-02T10:00:00.000Z'
          )
        )
      )
      .mockResolvedValue(
        ok(
          page([
            { id: '2', title: 'Older', actorName: 'Sam', createdAt: '2026-09-20T10:00:00.000Z' },
          ])
        )
      );
    const user = userEvent.setup();
    render(<GroupFeed />);
    await screen.findByText('Newer');

    await user.click(screen.getByRole('button', { name: 'Show older' }));

    expect(await screen.findByText('Older')).toBeInTheDocument();
    expect(feedCalls().some((url) => url.includes('before=2026-10-02T10%3A00%3A00.000Z'))).toBe(
      true
    );
  });

  it('says so when the feed cannot be loaded', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
    render(<GroupFeed />);

    expect(await screen.findByText('The feed could not be loaded.')).toBeInTheDocument();
  });

  it('says so when nothing has happened yet', async () => {
    fetchMock.mockResolvedValue(ok(page([])));
    render(<GroupFeed />);

    expect(await screen.findByText('Nothing has happened here yet.')).toBeInTheDocument();
  });

  describe('13m: the feed is not a monitor', () => {
    // Thirty lines by one member and one by another: the shape a leaderboard
    // would be built from, if anything on this surface counted.
    const busy = Array.from({ length: 30 }, (_, n) => ({
      id: `s${n}`,
      title: `Reading ${String.fromCharCode(65 + (n % 26))}${n >= 26 ? 'b' : ''}`,
      actorName: 'Sam',
      createdAt: new Date(Date.UTC(2026, 9, 1, 10, 0, 0) - n * 60_000).toISOString(),
    }));
    const quiet = {
      id: 'p0',
      title: 'Glossary',
      actorName: 'Priya',
      createdAt: '2026-09-25T10:00:00.000Z',
    };

    it('shows no count, total, rate, ranking or superlative over members', async () => {
      fetchMock.mockResolvedValue(ok(page([...busy, quiet])));
      const { container } = render(<GroupFeed />);
      await screen.findByText('Glossary');

      // Dates render through ClientDate, which is the one place digits may
      // appear; everything else on the surface must be free of them.
      const text = Array.from(container.querySelectorAll('li > span:first-child'))
        .map((node) => node.textContent ?? '')
        .join('\n');
      const heading = container.querySelector('header')?.textContent ?? '';

      expect(`${text}\n${heading}`).not.toMatch(/\d/);
      expect(container.textContent).not.toMatch(/\b(items?|most|top|streak|total|rank|leader)\b/i);
    });

    it('starts every line with the item, never with a person', async () => {
      fetchMock.mockResolvedValue(ok(page([...busy, quiet])));
      render(<GroupFeed />);
      await screen.findByText('Glossary');

      for (const item of screen.getAllByRole('listitem')) {
        const first = item.querySelector('span > span');
        expect(first?.textContent).not.toMatch(/^(Sam|Priya)\b/);
      }
    });

    it('filters to one person as rows, with nothing counting them', async () => {
      fetchMock.mockResolvedValue(ok(page([...busy, quiet])));
      const user = userEvent.setup();
      render(<GroupFeed />);
      await screen.findByText('Glossary');

      fetchMock.mockResolvedValue(ok(page([quiet]), 'W/"b"'));
      await user.click(screen.getByRole('combobox', { name: 'Show what one person did' }));
      await user.click(await screen.findByRole('option', { name: 'Priya' }));

      const list = await waitFor(() => {
        const items = screen.getAllByRole('listitem');
        expect(items).toHaveLength(1);
        return items[0].parentElement as HTMLElement;
      });
      expect(within(list).getByText('Glossary')).toBeInTheDocument();
      expect(feedCalls().some((url) => url.includes('member=user_priya'))).toBe(true);
      expect(document.body.textContent).not.toMatch(/\b1 (item|line|thing)/i);
    });
  });
});

describe('GroupFeed: paging and polling', () => {
  it('pages from the oldest line on screen, and shows each line once', async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok(
          page(
            [
              { id: 'b', title: 'Second', actorName: 'Sam', createdAt: '2026-10-02T10:00:00.000Z' },
              { id: 'a', title: 'First', actorName: 'Sam', createdAt: '2026-10-01T10:00:00.000Z' },
            ],
            'more'
          )
        )
      )
      .mockResolvedValue(
        ok(
          page([
            // Overlaps what is already shown, as a page can once new lines push old ones down.
            { id: 'a', title: 'First', actorName: 'Sam', createdAt: '2026-10-01T10:00:00.000Z' },
            { id: 'z', title: 'Oldest', actorName: 'Sam', createdAt: '2026-09-20T10:00:00.000Z' },
          ])
        )
      );
    const user = userEvent.setup();
    render(<GroupFeed />);
    await screen.findByText('First');

    await user.click(screen.getByRole('button', { name: 'Show older' }));

    expect(await screen.findByText('Oldest')).toBeInTheDocument();
    expect(screen.getAllByText('First')).toHaveLength(1);
    expect(
      feedCalls().some((url) => url.includes(encodeURIComponent('2026-10-01T10:00:00.000Z|a')))
    ).toBe(true);
    // The last older page said there was nothing beyond it.
    expect(screen.queryByRole('button', { name: 'Show older' })).not.toBeInTheDocument();
  });

  it('does not poll a feed filtered to one person, which is a search', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchMock.mockResolvedValue(
        ok(page([{ id: '1', title: 'A', actorName: 'Sam', createdAt: '2026-10-01T10:00:00.000Z' }]))
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<GroupFeed />);
      await screen.findByText('A');
      await user.click(screen.getByRole('combobox', { name: 'Show what one person did' }));
      await user.click(await screen.findByRole('option', { name: 'Priya' }));
      await vi.waitFor(() =>
        expect(feedCalls().some((url) => url.includes('member=user_priya'))).toBe(true)
      );
      const before = feedCalls().length;

      await vi.advanceTimersByTimeAsync(90_000);

      expect(feedCalls().length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
