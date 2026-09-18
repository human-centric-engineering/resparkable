// @vitest-environment happy-dom
/**
 * Unit Tests: the browser client that carries the active workspace (phase 47).
 *
 * Twenty-one components in this tier fetch through this wrapper instead of
 * core's `apiClient`, so the whole of "a client component reads the workspace
 * the user is looking at" is four lines in one file. What has to hold:
 *
 *   1. **The workspace comes off the address bar, at call time.** Not from a
 *      context, a module variable or a cookie: those three can each outlive the
 *      navigation that changed the workspace, and a request built from a stale
 *      one reads the wrong brain while looking entirely normal.
 *   2. **No workspace in the URL means no param on the request**, so a user in
 *      no group is served by exactly the paths the tier has always used.
 *   3. **Everything else is forwarded untouched**, because the moment this
 *      wrapper starts having opinions about bodies or headers it becomes a
 *      second HTTP client to keep in step with core's.
 *
 * @see lib/framework/resparkable/api/client.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { apiClient } from '@/lib/api/client';
import { resparkableApi, withActiveSpace } from '@/lib/framework/resparkable/api/client';

/** Point the address bar somewhere without navigating a real browser. */
function addressBar(search: string): void {
  window.history.replaceState({}, '', `/resparkable/today${search}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  addressBar('');
});

describe('withActiveSpace', () => {
  it('adds nothing when the address bar names no workspace', () => {
    expect(withActiveSpace('/api/v1/resparkable/today')).toBe('/api/v1/resparkable/today');
  });

  it('adds the workspace the address bar is showing', () => {
    addressBar('?space=spc_group_1');

    expect(withActiveSpace('/api/v1/resparkable/today')).toBe(
      '/api/v1/resparkable/today?space=spc_group_1'
    );
  });

  it('ignores every other param on the page URL', () => {
    // The page's own query string is not the request's. A `?status=active` on
    // the projects page must not leak onto a call to `/counts`.
    addressBar('?status=active&day=2026-09-03');

    expect(withActiveSpace('/api/v1/resparkable/counts')).toBe('/api/v1/resparkable/counts');
  });

  it('appends to a path that already carries a query', () => {
    addressBar('?space=spc_group_1');

    expect(withActiveSpace('/api/v1/resparkable/projects?status=active')).toBe(
      '/api/v1/resparkable/projects?status=active&space=spc_group_1'
    );
  });

  it('reads the address bar at call time, not at import time', () => {
    // The failure this rules out: a user switches workspace, the module-level
    // value from first render is still in hand, and the next save writes into
    // the workspace they just left.
    expect(withActiveSpace('/api/v1/resparkable/today')).toBe('/api/v1/resparkable/today');

    addressBar('?space=spc_group_2');

    expect(withActiveSpace('/api/v1/resparkable/today')).toBe(
      '/api/v1/resparkable/today?space=spc_group_2'
    );
  });
});

describe('resparkableApi', () => {
  it('carries the workspace on every method', async () => {
    addressBar('?space=spc_group_1');

    await resparkableApi.get('/api/v1/resparkable/tasks');
    await resparkableApi.post('/api/v1/resparkable/tasks', { body: { title: 'x' } });
    await resparkableApi.put('/api/v1/resparkable/tasks/t1', { body: { title: 'y' } });
    await resparkableApi.patch('/api/v1/resparkable/tasks/t1', { body: { title: 'z' } });
    await resparkableApi.delete('/api/v1/resparkable/tasks/t1');

    // A write that missed the param would land in the caller's personal space,
    // which is the quiet half of this failure: no error, and the row is simply
    // in the wrong brain.
    expect(apiClient.get).toHaveBeenCalledWith('/api/v1/resparkable/tasks?space=spc_group_1');
    expect(apiClient.post).toHaveBeenCalledWith('/api/v1/resparkable/tasks?space=spc_group_1', {
      body: { title: 'x' },
    });
    expect(apiClient.put).toHaveBeenCalledWith('/api/v1/resparkable/tasks/t1?space=spc_group_1', {
      body: { title: 'y' },
    });
    expect(apiClient.patch).toHaveBeenCalledWith('/api/v1/resparkable/tasks/t1?space=spc_group_1', {
      body: { title: 'z' },
    });
    expect(apiClient.delete).toHaveBeenCalledWith('/api/v1/resparkable/tasks/t1?space=spc_group_1');
  });

  it('forwards options untouched', async () => {
    const signal = new AbortController().signal;

    await resparkableApi.post('/api/v1/resparkable/tasks', {
      body: { title: 'x' },
      params: { dryRun: true },
      options: { signal },
    });

    expect(apiClient.post).toHaveBeenCalledWith('/api/v1/resparkable/tasks', {
      body: { title: 'x' },
      params: { dryRun: true },
      options: { signal },
    });
  });

  it('leaves an omitted options argument omitted', async () => {
    await resparkableApi.get('/api/v1/resparkable/today');

    // Not `(path, undefined)`. The wrapper is a pass-through, and a call shape
    // it invented would be a habit of its own to keep in step with core's.
    expect(apiClient.get).toHaveBeenCalledWith('/api/v1/resparkable/today');
    expect(vi.mocked(apiClient.get).mock.calls[0]).toHaveLength(1);
  });

  it('leaves the path alone for a user in no group', async () => {
    await resparkableApi.get('/api/v1/resparkable/today');

    expect(apiClient.get).toHaveBeenCalledWith('/api/v1/resparkable/today');
  });
});
