import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchMutuals } from './mutuals';

// Contract under test (plan U17/U18): fetchMutuals(actorDid) fetches the
// actor's full follows and followers lists from the public AppView
// (https://public.api.bsky.app) via app.bsky.graph.getFollows /
// app.bsky.graph.getFollowers, walking `cursor` pagination until exhausted,
// and resolves to the DID-keyed intersection (mutuals) as a
// Map<did, profile>. Errors from the AppView surface as rejections, never as
// a silently-empty result.

interface Profile {
  did: string;
  handle: string;
  displayName?: string;
}

interface Page {
  items: Profile[];
  cursor?: string;
}

const APPVIEW_ORIGIN = 'https://public.api.bsky.app';
const GET_FOLLOWS_PATH = '/xrpc/app.bsky.graph.getFollows';
const GET_FOLLOWERS_PATH = '/xrpc/app.bsky.graph.getFollowers';
const ME = 'did:plc:me0000000000000000000000';

function profile(name: string): Profile {
  return { did: `did:plc:${name}`, handle: `${name}.bsky.social`, displayName: name };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: unknown): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  return new URL((input as Request).url);
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Serve paginated getFollows/getFollowers responses the way the public
 * AppView does: no `cursor` param -> first page; `cursor=X` -> the page
 * after the page that handed out cursor X; a page without `cursor` in its
 * body is the last one.
 */
function mockAppView(followsPages: Page[], followersPages: Page[]): void {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = requestUrl(input);
    const cursor = url.searchParams.get('cursor');
    const serve = (key: 'follows' | 'followers', pages: Page[]) => {
      let index = 0;
      if (cursor !== null) {
        const previous = pages.findIndex((p) => p.cursor === cursor);
        if (previous === -1) throw new Error(`unknown cursor: ${cursor}`);
        index = previous + 1;
      }
      const page = pages[index] ?? { items: [] };
      return json({
        subject: profile('me'),
        [key]: page.items,
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
      });
    };
    if (url.pathname === GET_FOLLOWS_PATH) return serve('follows', followsPages);
    if (url.pathname === GET_FOLLOWERS_PATH) return serve('followers', followersPages);
    throw new Error(`unexpected request path: ${url.pathname}`);
  });
}

function callsTo(path: string): URL[] {
  return fetchMock.mock.calls
    .map(([input]: unknown[]) => requestUrl(input))
    .filter((u: URL) => u.pathname === path);
}

describe('fetchMutuals — happy path (single page)', () => {
  it('returns the DID-keyed intersection of follows and followers', async () => {
    mockAppView(
      [{ items: [profile('alice'), profile('bob'), profile('carol')] }],
      [{ items: [profile('bob'), profile('carol'), profile('dave')] }],
    );

    const mutuals = await fetchMutuals(ME);

    expect(mutuals).toBeInstanceOf(Map);
    expect([...mutuals.keys()].sort()).toEqual(['did:plc:bob', 'did:plc:carol']);
    expect(mutuals.get('did:plc:bob')).toMatchObject({
      did: 'did:plc:bob',
      handle: 'bob.bsky.social',
    });
  });

  it('queries getFollows and getFollowers on the public AppView for the given actor', async () => {
    mockAppView([{ items: [profile('bob')] }], [{ items: [profile('bob')] }]);

    await fetchMutuals(ME);

    const followsCalls = callsTo(GET_FOLLOWS_PATH);
    const followersCalls = callsTo(GET_FOLLOWERS_PATH);
    expect(followsCalls.length).toBeGreaterThanOrEqual(1);
    expect(followersCalls.length).toBeGreaterThanOrEqual(1);
    for (const url of [...followsCalls, ...followersCalls]) {
      expect(url.origin).toBe(APPVIEW_ORIGIN);
      expect(url.searchParams.get('actor')).toBe(ME);
    }
    // Nothing but the two follow-graph endpoints is contacted.
    expect(fetchMock.mock.calls.length).toBe(followsCalls.length + followersCalls.length);
  });
});

describe('fetchMutuals — cursor pagination', () => {
  it('walks cursors on both endpoints until exhausted and finds cross-page mutuals', async () => {
    mockAppView(
      [
        { items: [profile('alice'), profile('bob')], cursor: 'follows-p2' },
        { items: [profile('carol')] },
      ],
      [
        { items: [profile('bob')], cursor: 'followers-p2' },
        { items: [profile('carol'), profile('dave')] },
      ],
    );

    const mutuals = await fetchMutuals(ME);

    // carol is a mutual only if BOTH endpoints were paginated to the end.
    expect([...mutuals.keys()].sort()).toEqual(['did:plc:bob', 'did:plc:carol']);

    const followsCalls = callsTo(GET_FOLLOWS_PATH);
    const followersCalls = callsTo(GET_FOLLOWERS_PATH);
    expect(followsCalls).toHaveLength(2);
    expect(followersCalls).toHaveLength(2);
    expect(followsCalls.some((u) => u.searchParams.get('cursor') === 'follows-p2')).toBe(true);
    expect(followersCalls.some((u) => u.searchParams.get('cursor') === 'followers-p2')).toBe(true);
  });

  it('sends no cursor param on the first request to each endpoint', async () => {
    mockAppView(
      [{ items: [profile('bob')], cursor: 'follows-p2' }, { items: [] }],
      [{ items: [profile('bob')] }],
    );

    await fetchMutuals(ME);

    expect(callsTo(GET_FOLLOWS_PATH)[0].searchParams.get('cursor')).toBeNull();
    expect(callsTo(GET_FOLLOWERS_PATH)[0].searchParams.get('cursor')).toBeNull();
  });

  it('deduplicates by DID when the same profile appears on multiple pages', async () => {
    mockAppView(
      [
        { items: [profile('bob')], cursor: 'follows-p2' },
        { items: [profile('bob'), profile('carol')] },
      ],
      [{ items: [profile('bob'), profile('carol')] }],
    );

    const mutuals = await fetchMutuals(ME);

    expect(mutuals.size).toBe(2);
    expect([...mutuals.keys()].sort()).toEqual(['did:plc:bob', 'did:plc:carol']);
  });
});

describe('fetchMutuals — empty results', () => {
  it('returns an empty map when the actor follows no one', async () => {
    mockAppView([{ items: [] }], [{ items: [profile('bob')] }]);

    const mutuals = await fetchMutuals(ME);

    expect(mutuals).toBeInstanceOf(Map);
    expect(mutuals.size).toBe(0);
  });

  it('returns an empty map when the actor has no followers', async () => {
    mockAppView([{ items: [profile('bob')] }], [{ items: [] }]);

    expect((await fetchMutuals(ME)).size).toBe(0);
  });

  it('returns an empty map when both lists are empty', async () => {
    mockAppView([{ items: [] }], [{ items: [] }]);

    expect((await fetchMutuals(ME)).size).toBe(0);
  });
});

describe('fetchMutuals — non-mutual exclusion', () => {
  it('excludes accounts present only in follows or only in followers', async () => {
    mockAppView(
      [{ items: [profile('only-followed'), profile('bob')] }],
      [{ items: [profile('bob'), profile('only-follower')] }],
    );

    const mutuals = await fetchMutuals(ME);

    expect(mutuals.has('did:plc:only-followed')).toBe(false);
    expect(mutuals.has('did:plc:only-follower')).toBe(false);
    expect([...mutuals.keys()]).toEqual(['did:plc:bob']);
  });

  it('returns an empty map when the two lists are disjoint', async () => {
    mockAppView(
      [{ items: [profile('alice'), profile('bob')] }],
      [{ items: [profile('carol'), profile('dave')] }],
    );

    expect((await fetchMutuals(ME)).size).toBe(0);
  });
});

describe('fetchMutuals — error handling', () => {
  it('rejects when the AppView responds with a non-OK status', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: 'InternalServerError' }), { status: 500 }),
    );

    await expect(fetchMutuals(ME)).rejects.toThrow();
  });

  it('rejects when fetch itself fails (network error)', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'));

    await expect(fetchMutuals(ME)).rejects.toThrow();
  });

  it('rejects when a later pagination page fails, instead of returning a partial result', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = requestUrl(input);
      if (url.searchParams.get('cursor') !== null) {
        return new Response('upstream exploded', { status: 502 });
      }
      if (url.pathname === GET_FOLLOWS_PATH) {
        return json({ subject: profile('me'), follows: [profile('bob')], cursor: 'p2' });
      }
      return json({ subject: profile('me'), followers: [profile('bob')] });
    });

    await expect(fetchMutuals(ME)).rejects.toThrow();
  });
});
