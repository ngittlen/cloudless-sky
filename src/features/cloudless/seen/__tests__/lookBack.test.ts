import {type FeedAPI} from '#/lib/api/feed/types'
import {FeedTuner} from '#/lib/api/feed-manip'
import {
  resetSeenFeedStateForTests,
  setHideSeen,
  setSeenSnapshotTime,
} from '#/features/cloudless/seen/feedState'
import {getFeedItemSortTime} from '#/features/cloudless/seen/lookBack'
import {
  MAX_SEARCH_REQUESTS,
  SEARCH_PAGE_SIZE,
  SeenFilteringFeedAPI,
} from '#/features/cloudless/seen/SeenFilteringFeedAPI'
import {SeenListRegistry} from '#/features/cloudless/seen/seenList'
import {createHideSeenTuner} from '#/features/cloudless/seen/tuner'
import {type app} from '#/lexicons'

jest.mock('#/lib/api/feed/home', () => ({
  FALLBACK_MARKER_POST: {post: {uri: 'fallback-marker-post'}},
}))

const ME = 'did:plc:me'
const MINUTE = 60_000
/**
 * "Now" in these tests. Post times count back from it.
 */
const NOW = Date.parse('2026-11-07T12:00:00.000Z')

const author = {
  $type: 'app.bsky.actor.defs#profileViewBasic',
  did: 'did:plc:alice',
  handle: 'alice.test',
} satisfies app.bsky.actor.defs.ProfileViewBasic

function uri(id: string | number) {
  return `at://did:plc:alice/app.bsky.feed.post/${id}` as const
}

function iso(ms: number) {
  return new Date(ms).toISOString() as app.bsky.feed.defs.PostView['indexedAt']
}

/**
 * A post that entered the timeline `minutesAgo` before NOW.
 */
function item(
  id: string | number,
  minutesAgo: number,
): app.bsky.feed.defs.FeedViewPost {
  return {
    post: {
      $type: 'app.bsky.feed.defs#postView',
      uri: uri(id),
      cid: 'cid',
      author,
      record: {
        $type: 'app.bsky.feed.post',
        text: String(id),
        createdAt: iso(NOW - minutesAgo * MINUTE),
      },
      indexedAt: iso(NOW - minutesAgo * MINUTE),
    },
  }
}

function repostOf(
  original: app.bsky.feed.defs.FeedViewPost,
  minutesAgo: number,
): app.bsky.feed.defs.FeedViewPost {
  return {
    post: original.post,
    reason: {
      $type: 'app.bsky.feed.defs#reasonRepost',
      by: {...author, did: 'did:plc:carol', handle: 'carol.test'},
      indexedAt: iso(NOW - minutesAgo * MINUTE),
    },
  }
}

/**
 * A timeline served in pages, newest first, with numeric offsets as cursors.
 */
function timeline(feed: app.bsky.feed.defs.FeedViewPost[]) {
  const api = {
    requests: [] as {cursor: string | undefined; limit: number}[],
    peekLatest: () => Promise.resolve(feed[0]),
    fetch({cursor, limit}: {cursor: string | undefined; limit: number}) {
      api.requests.push({cursor, limit})
      const start = cursor ? Number(cursor) : 0
      const end = start + limit
      return Promise.resolve({
        feed: feed.slice(start, end),
        cursor: end < feed.length ? String(end) : undefined,
      })
    },
  }
  return api
}

function setup(limit = 1_000) {
  const registry = new SeenListRegistry({
    storage: null,
    channel: null,
    now: () => NOW,
    limit,
    flushIntervalMs: 60_000,
    loadTimeoutMs: 1_000,
  })
  return {registry, list: registry.get(ME)}
}

function wrap(inner: FeedAPI, registry: SeenListRegistry) {
  return new SeenFilteringFeedAPI(inner, ME, {
    lists: registry,
    now: () => NOW,
  })
}

function uris(feed: app.bsky.feed.defs.FeedViewPost[]) {
  return feed.map(f => f.post.uri)
}

beforeEach(() => {
  resetSeenFeedStateForTests()
})

describe('look-back limit', () => {
  it('ends the feed at the moment the oldest remembered post was seen', async () => {
    const {registry, list} = setup()
    list.add([uri('read')], NOW - 30 * MINUTE)
    const inner = timeline([
      item('new', 5),
      item('read', 40),
      item('before', 31),
      item('old', 60),
    ])
    const api = wrap(inner, registry)

    const res = await api.fetch({cursor: undefined, limit: 30})

    expect(res.cursor).toBeUndefined()
    // Older posts stay in the cache; the tuner hides them.
    expect(uris(res.feed)).toEqual([
      uri('new'),
      uri('read'),
      uri('before'),
      uri('old'),
    ])
  })

  it('keeps the real cursor where it ended the feed', async () => {
    const {registry, list} = setup()
    list.add([uri(0)], NOW - 30 * MINUTE)
    const feed = Array.from({length: 250}, (_, i) => item(i, i))
    const api = wrap(timeline(feed), registry)

    const res = await api.fetch({cursor: undefined, limit: 30})

    expect(res.cursor).toBeUndefined()
    expect(api.savedCursor).toBe(String(SEARCH_PAGE_SIZE))
  })

  it('returns no cursor when a page starts past the limit', async () => {
    const {registry, list} = setup()
    list.add([uri(0)], NOW - 30 * MINUTE)
    const feed = Array.from({length: 300}, (_, i) => item(i, i))
    const api = wrap(timeline(feed), registry)
    setSeenSnapshotTime(ME, NOW)

    const res = await api.fetch({cursor: '200', limit: 30})

    expect(res.cursor).toBeUndefined()
  })

  it('has no limit with an empty seen list', async () => {
    const {registry} = setup()
    const feed = Array.from({length: 250}, (_, i) => item(i, i * 60))
    const api = wrap(timeline(feed), registry)

    const res = await api.fetch({cursor: undefined, limit: 30})

    expect(res.cursor).toBe(String(SEARCH_PAGE_SIZE))
    expect(res.feed).toHaveLength(SEARCH_PAGE_SIZE)
  })

  it('counts only posts known when the feed loaded', async () => {
    // First use: nothing seen at load, so this session has no limit.
    const {registry, list} = setup()
    setSeenSnapshotTime(ME, NOW - MINUTE)
    list.add([uri(0)], NOW)
    const feed = Array.from({length: 250}, (_, i) => item(i, i))
    const api = wrap(timeline(feed), registry)

    const res = await api.fetch({cursor: '100', limit: 30})

    expect(res.cursor).toBe('200')
  })

  it('moves forward as the oldest posts drop off the list', async () => {
    const {registry, list} = setup(2)
    list.add([uri('a')], NOW - 100 * MINUTE)
    list.add([uri('b')], NOW - 50 * MINUTE)
    const feed = [item('x', 10), item('y', 70), item('z', 120)]

    const before = await wrap(timeline(feed), registry).fetch({
      cursor: undefined,
      limit: 30,
    })
    list.add([uri('c')], NOW - 5 * MINUTE)
    const tuner = createHideSeenTuner(ME, undefined, registry)
    const after = new FeedTuner([tuner]).tune(before.feed)

    // `a` dropped, so the limit moved from 100 to 50 minutes ago.
    expect(list.oldestSeenAt(NOW)).toBe(NOW - 50 * MINUTE)
    expect(after.map(s => s._feedPost.post.uri)).toEqual([uri('x')])
  })

  it('counts a repost by when it was reposted', () => {
    const {registry, list} = setup()
    list.add([uri('seen')], NOW - 30 * MINUTE)
    setSeenSnapshotTime(ME, NOW)
    const oldPost = item('old', 600)
    const newPost = item('new', 20)
    const tuner = createHideSeenTuner(ME, undefined, registry)

    const slices = new FeedTuner([tuner]).tune([
      repostOf(oldPost, 10),
      repostOf(newPost, 45),
    ])

    expect(getFeedItemSortTime(repostOf(oldPost, 10))).toBe(NOW - 10 * MINUTE)
    expect(slices.map(s => s._feedPost.post.uri)).toEqual([uri('old')])
  })

  it('hides posts older than the limit that were loaded earlier', () => {
    const {registry, list} = setup()
    list.add([uri('seen')], NOW - 30 * MINUTE)
    setSeenSnapshotTime(ME, NOW)
    const tuner = createHideSeenTuner(ME, undefined, registry)

    const slices = new FeedTuner([tuner]).tune([
      item('newer', 10),
      item('older', 40),
    ])

    expect(slices.map(s => s._feedPost.post.uri)).toEqual([uri('newer')])
  })

  it('ends the feed where Home would fall back to Discover', async () => {
    const {registry, list} = setup()
    list.add([uri('seen')], NOW - 300 * MINUTE)
    const marker = {
      post: {uri: 'fallback-marker-post'},
    } as unknown as app.bsky.feed.defs.FeedViewPost
    const api = wrap(
      timeline([item('a', 1), marker, item('discover', 2)]),
      registry,
    )

    const res = await api.fetch({cursor: undefined, limit: 30})

    expect(uris(res.feed)).toEqual([uri('a')])
    expect(res.cursor).toBeUndefined()
  })
})

describe('searching past seen posts', () => {
  it('skips a long run of seen posts to the first unseen one', async () => {
    const {registry, list} = setup(10_000)
    const feed = Array.from({length: 400}, (_, i) => item(i, i))
    list.add(
      feed.slice(0, 250).map(f => f.post.uri),
      NOW - 1_000 * MINUTE,
    )
    const inner = timeline(feed)
    const api = wrap(inner, registry)

    const res = await api.fetch({cursor: undefined, limit: 30})

    expect(inner.requests).toEqual([
      {cursor: undefined, limit: SEARCH_PAGE_SIZE},
      {cursor: '100', limit: SEARCH_PAGE_SIZE},
      {cursor: '200', limit: SEARCH_PAGE_SIZE},
    ])
    expect(res.feed).toHaveLength(300)
    expect(res.cursor).toBe('300')
  })

  it('stops at the request cap and lets the next page carry on', async () => {
    const {registry, list} = setup(10_000)
    const feed = Array.from({length: 2_000}, (_, i) => item(i, i / 100))
    list.add(
      feed.map(f => f.post.uri),
      NOW - 1_000 * MINUTE,
    )
    const inner = timeline(feed)
    const api = wrap(inner, registry)

    const res = await api.fetch({cursor: undefined, limit: 30})

    expect(inner.requests).toHaveLength(MAX_SEARCH_REQUESTS)
    expect(res.feed).toHaveLength(MAX_SEARCH_REQUESTS * SEARCH_PAGE_SIZE)
    expect(res.cursor).toBe(String(MAX_SEARCH_REQUESTS * SEARCH_PAGE_SIZE))
  })

  it('does not stop for an unseen post the feed would drop anyway', async () => {
    const {registry, list} = setup(10_000)
    const feed = Array.from({length: 300}, (_, i) => item(i, i))
    // Everything in the first 250 is seen except post 99.
    list.add(
      feed
        .slice(0, 250)
        .map(f => f.post.uri)
        .filter(u => u !== uri(99)),
      NOW - 1_000 * MINUTE,
    )
    const inner = timeline(feed)
    const api = new SeenFilteringFeedAPI(inner, ME, {
      lists: registry,
      now: () => NOW,
      // The feed's own tuners drop post 99, say as a reply to a stranger.
      feedTuners: [
        (_tuner, slices) =>
          slices.filter(s => s._feedPost.post.uri !== uri(99)),
      ],
    })

    await api.fetch({cursor: undefined, limit: 30})

    expect(inner.requests).toHaveLength(3)
  })

  it('keeps what it found when a later request fails', async () => {
    const {registry, list} = setup(10_000)
    const feed = Array.from({length: 400}, (_, i) => item(i, i))
    list.add(
      feed.map(f => f.post.uri),
      NOW - 1_000 * MINUTE,
    )
    const inner = timeline(feed)
    const fetch = inner.fetch
    inner.fetch = params =>
      params.cursor === '200'
        ? Promise.reject(new Error('offline'))
        : fetch(params)
    const api = wrap(inner, registry)

    const res = await api.fetch({cursor: undefined, limit: 30})

    expect(res.feed).toHaveLength(200)
    expect(res.cursor).toBe('200')
  })

  it('fails when the first request fails', async () => {
    const {registry} = setup()
    const api = wrap(
      {
        peekLatest: () => Promise.reject(new Error('offline')),
        fetch: () => Promise.reject(new Error('offline')),
      },
      registry,
    )

    await expect(api.fetch({cursor: undefined, limit: 30})).rejects.toThrow(
      'offline',
    )
  })

  it('passes requests through unchanged while seen posts are shown', async () => {
    const {registry, list} = setup()
    list.add([uri(0)], NOW - 30 * MINUTE)
    setHideSeen(false)
    const feed = Array.from({length: 300}, (_, i) => item(i, i))
    const inner = timeline(feed)
    const api = wrap(inner, registry)

    const res = await api.fetch({cursor: undefined, limit: 30})

    expect(inner.requests).toEqual([{cursor: undefined, limit: 30}])
    expect(res.cursor).toBe('30')
  })
})
