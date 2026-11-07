import {
  resetSeenFeedStateForTests,
  setSeenSnapshotTime,
} from '#/features/cloudless/seen/feedState'
import {
  MAX_SEARCH_REQUESTS,
  SeenFilteringFeedAPI,
} from '#/features/cloudless/seen/SeenFilteringFeedAPI'
import {SeenListRegistry} from '#/features/cloudless/seen/seenList'
import {type app} from '#/lexicons'

jest.mock('#/lib/api/feed/home', () => ({
  FALLBACK_MARKER_POST: {post: {uri: 'fallback-marker-post'}},
}))
jest.mock('#/logger', () => ({
  logger: {info: jest.fn(), warn: jest.fn(), error: jest.fn()},
}))

const ME = 'did:plc:me'
const MINUTE = 60_000
const NOW = Date.parse('2026-11-07T12:00:00.000Z')

function uri(id: string | number) {
  return `at://did:plc:alice/app.bsky.feed.post/${id}` as const
}

/**
 * A post that entered the timeline `minutesAgo` before NOW.
 */
function item(id: number, minutesAgo: number): app.bsky.feed.defs.FeedViewPost {
  const indexedAt = new Date(
    NOW - minutesAgo * MINUTE,
  ).toISOString() as app.bsky.feed.defs.PostView['indexedAt']
  return {
    post: {
      $type: 'app.bsky.feed.defs#postView',
      uri: uri(id),
      cid: 'cid',
      author: {
        $type: 'app.bsky.actor.defs#profileViewBasic',
        did: 'did:plc:alice',
        handle: 'alice.test',
      },
      record: {
        $type: 'app.bsky.feed.post',
        text: String(id),
        createdAt: indexedAt,
      },
      indexedAt,
    },
  }
}

function timeline(feed: app.bsky.feed.defs.FeedViewPost[]) {
  const api = {
    requests: [] as (string | undefined)[],
    peekLatest: () => Promise.resolve(feed[0]),
    fetch({cursor, limit}: {cursor: string | undefined; limit: number}) {
      api.requests.push(cursor)
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

beforeEach(() => {
  resetSeenFeedStateForTests()
})

it('keeps the look-back limit until the next refresh after a sync merges older posts', async () => {
  let clock = NOW
  const registry = new SeenListRegistry({
    storage: null,
    channel: null,
    now: () => clock,
    limit: 1_000,
    flushIntervalMs: 60_000,
    loadTimeoutMs: 1_000,
  })
  const list = registry.get(ME)
  list.add([uri('read')], NOW - 30 * MINUTE)
  const inner = timeline(Array.from({length: 300}, (_, i) => item(i, i)))
  const api = new SeenFilteringFeedAPI(inner, ME, {
    lists: registry,
    now: () => clock,
  })

  // The feed ends 30 minutes back, where the oldest seen post was seen.
  const first = await api.fetch({cursor: undefined, limit: 30})
  expect(first.cursor).toBeUndefined()
  expect(api.savedCursor).toBe('100')

  // Sync brings in a post another device saw 150 minutes ago.
  clock += MINUTE
  await list.applySynced([{uri: uri('elsewhere'), seenAt: NOW - 150 * MINUTE}])

  // Mid-scroll, the limit is unchanged: past it is still an empty page.
  const requests = inner.requests.length
  const scrolled = await api.fetch({cursor: '100', limit: 30})
  expect(scrolled).toEqual({feed: []})
  expect(inner.requests).toHaveLength(requests)

  // After a refresh, the limit is 150 minutes back, so the cursor that led
  // past the old limit is fetched again.
  clock += MINUTE
  const refreshed = await api.fetch({cursor: undefined, limit: 30})
  setSeenSnapshotTime(ME, clock)
  expect(refreshed.cursor).toBe('100')
  const further = await api.fetch({cursor: '100', limit: 30})
  expect(inner.requests.at(-1)).toBe('100')
  expect(further.feed.map(f => f.post.uri)).toContain(uri(100))
  expect(further.cursor).toBeUndefined()
  expect(api.savedCursor).toBe('200')
})

it('stops searching at posts a sync merged after the snapshot, since they are shown', async () => {
  let clock = NOW
  const registry = new SeenListRegistry({
    storage: null,
    channel: null,
    now: () => clock,
    limit: 10_000,
    flushIntervalMs: 60_000,
    loadTimeoutMs: 1_000,
  })
  const list = registry.get(ME)
  const feed = Array.from({length: 2_000}, (_, i) => item(i, i / 100))
  const inner = timeline(feed)
  const api = new SeenFilteringFeedAPI(inner, ME, {
    lists: registry,
    now: () => clock,
  })
  await api.fetch({cursor: undefined, limit: 30})

  // Sync merges every post in the timeline after the feed loaded.
  clock += MINUTE
  await list.applySynced(
    feed.map(f => ({uri: f.post.uri, seenAt: NOW - 1_000 * MINUTE})),
  )

  const requests = inner.requests.length
  const res = await api.fetch({cursor: '100', limit: 30})
  // One request: its posts were not known seen at the snapshot, so the
  // tuner shows them and the search has found something to show.
  expect(inner.requests.length - requests).toBe(1)
  expect(MAX_SEARCH_REQUESTS).toBeGreaterThan(1)
  expect(res.cursor).toBe('200')
})
