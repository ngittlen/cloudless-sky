import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {act, render} from '@testing-library/react-native'

import {type FeedAPI} from '#/lib/api/feed/types'
import {FeedTuner} from '#/lib/api/feed-manip'
import {
  chooseScrollAnchor,
  findAnchorTarget,
  SeenAnchorRows,
} from '#/features/cloudless/seen/anchor'
import {SeenFeedProvider, useSeenFeed} from '#/features/cloudless/seen/context'
import {
  getHideSeen,
  getSeenSnapshotTime,
  resetSeenFeedStateForTests,
  setHideSeen,
  setSeenSnapshotTime,
  subscribeToSeenFeedState,
  switchHideSeen,
} from '#/features/cloudless/seen/feedState'
import {
  createDeviceHideSeenStore,
  createMemoryHideSeenStore,
  type HideSeenSettingStore,
} from '#/features/cloudless/seen/hideSeenSetting'
import {
  restoreSavedCursor,
  SeenFilteringFeedAPI,
} from '#/features/cloudless/seen/SeenFilteringFeedAPI'
import {
  getSeenLists,
  SeenListRegistry,
} from '#/features/cloudless/seen/seenList'
import {createHideSeenTuner} from '#/features/cloudless/seen/tuner'
import {useToggleHideSeen} from '#/features/cloudless/seen/useToggleHideSeen'
import {type app} from '#/lexicons'

jest.mock('#/lib/api/feed/home', () => ({
  FALLBACK_MARKER_POST: {post: {uri: 'fallback-marker-post'}},
}))
// `useToggleHideSeen` needs only the query key root from `post-feed`.
jest.mock('#/state/queries/post-feed', () => ({RQKEY_ROOT: 'post-feed'}))
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: {did: mockDid}}),
}))
jest.mock('#/state/shell/shell-layout', () => ({
  useShellLayout: () => ({headerHeight: {get: () => 50}}),
}))
jest.mock('#/view/com/util/MainScrollProvider', () => ({
  useHomeHeaderMode: () => ({get: () => 0}),
}))
jest.mock('#/alf', () => ({
  useBreakpoints: () => ({gtMobile: true}),
}))

const ME = 'did:plc:me'
const MINUTE = 60_000
const NOW = Date.parse('2026-11-07T12:00:00.000Z')

let mockDid = 'did:plc:toggle-1'
let didCounter = 1

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

/**
 * A timeline served in pages, newest first, with numeric offsets as cursors.
 * `gate` holds requests until it is resolved.
 */
function timeline(feed: app.bsky.feed.defs.FeedViewPost[]) {
  const api = {
    requests: [] as (string | undefined)[],
    gate: undefined as Promise<void> | undefined,
    peekLatest: () => Promise.resolve(feed[0]),
    async fetch({cursor, limit}: {cursor: string | undefined; limit: number}) {
      api.requests.push(cursor)
      if (api.gate) await api.gate
      const start = cursor ? Number(cursor) : 0
      const end = start + limit
      return {
        feed: feed.slice(start, end),
        cursor: end < feed.length ? String(end) : undefined,
      }
    },
  }
  return api
}

function setup(now: () => number = () => NOW) {
  const registry = new SeenListRegistry({
    storage: null,
    channel: null,
    now,
    limit: 1_000,
    flushIntervalMs: 60_000,
    loadTimeoutMs: 1_000,
  })
  return {registry, list: registry.get(ME)}
}

function wrap(inner: FeedAPI, registry: SeenListRegistry) {
  return new SeenFilteringFeedAPI(inner, ME, {lists: registry, now: () => NOW})
}

/**
 * The query cache's shape for a feed, as `usePostFeedQuery` stores it.
 */
type Cached = {
  pages: {api: FeedAPI; cursor: string | undefined; feed: unknown[]}[]
  pageParams: unknown[]
}

async function loadPage(api: FeedAPI, data: Cached | undefined) {
  const cursor = data?.pages[data.pages.length - 1].cursor
  const res = await api.fetch({cursor, limit: 30})
  return {
    pages: [...(data?.pages ?? []), {api, cursor: res.cursor, feed: res.feed}],
    pageParams: [...(data?.pageParams ?? []), cursor],
  }
}

beforeEach(() => {
  resetSeenFeedStateForTests()
})

describe('remembered setting', () => {
  it('hides seen posts by default', () => {
    expect(getHideSeen()).toBe(true)
  })

  it('remembers the choice across a restart', () => {
    const store = createMemoryHideSeenStore()
    resetSeenFeedStateForTests(store)
    setHideSeen(false)

    // A reload starts from the saved value.
    resetSeenFeedStateForTests(store)
    expect(getHideSeen()).toBe(false)

    switchHideSeen(ME, true, NOW)
    resetSeenFeedStateForTests(store)
    expect(getHideSeen()).toBe(true)
  })

  it('saves and reads the choice through the device store', () => {
    const store = createDeviceHideSeenStore()
    expect(store.load()).toBeUndefined()
    store.save(false)
    expect(store.load()).toBe(false)
    store.save(true)
    expect(store.load()).toBe(true)
  })

  it('falls back to hiding when storage cannot be read', () => {
    const broken: HideSeenSettingStore = {
      load: () => {
        throw new Error('storage unavailable')
      },
      save: () => {
        throw new Error('storage unavailable')
      },
    }
    resetSeenFeedStateForTests(broken)
    expect(getHideSeen()).toBe(true)

    // A failed save still switches for this session.
    setHideSeen(false)
    expect(getHideSeen()).toBe(false)
  })
})

describe('snapshot time on switch', () => {
  it('moves to now when switching to hiding', () => {
    setSeenSnapshotTime(ME, NOW - 10 * MINUTE)
    setHideSeen(false)

    switchHideSeen(ME, true, NOW)

    expect(getHideSeen()).toBe(true)
    expect(getSeenSnapshotTime(ME)).toBe(NOW)
  })

  it('moves to now when switching to showing, for the badges', () => {
    setSeenSnapshotTime(ME, NOW - 10 * MINUTE)

    switchHideSeen(ME, false, NOW)

    expect(getHideSeen()).toBe(false)
    expect(getSeenSnapshotTime(ME)).toBe(NOW)
  })

  it('never moves backwards', () => {
    setSeenSnapshotTime(ME, NOW)
    switchHideSeen(ME, true, NOW - MINUTE)
    expect(getSeenSnapshotTime(ME)).toBe(NOW)
  })

  it('updates listeners once per switch', () => {
    const listener = jest.fn()
    const unsubscribe = subscribeToSeenFeedState(listener)
    switchHideSeen(ME, false, NOW)
    switchHideSeen(ME, true, NOW)
    unsubscribe()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('hides posts seen while seen posts were shown', () => {
    let clock = NOW - 20 * MINUTE
    const {registry, list} = setup(() => clock)
    list.add([uri('before')], clock)
    clock = NOW - 5 * MINUTE
    setSeenSnapshotTime(ME, NOW - 10 * MINUTE)
    switchHideSeen(ME, false, NOW - 10 * MINUTE)
    // Seen while seen posts were shown, after the feed loaded.
    list.add([uri('while-shown')], NOW - 5 * MINUTE)
    const feed = [item('new', 1), item('while-shown', 2), item('before', 3)]
    const tuner = createHideSeenTuner(ME, undefined, registry)

    const kept = () =>
      new FeedTuner([tuner])
        .tune(feed, {dryRun: true})
        .map(slice => slice.items[0].post.uri)

    // Hidden as of the old snapshot: only the post seen before it.
    switchHideSeen(ME, true, NOW - 10 * MINUTE)
    expect(kept()).toEqual([uri('new'), uri('while-shown')])

    switchHideSeen(ME, true, NOW)
    expect(kept()).toEqual([uri('new')])
  })
})

describe('choosing the anchor', () => {
  // A 1000px screen with rows listed out of order.
  const VIEWPORT = 1_000
  const rows = [
    {id: 'c', top: 400, bottom: 900},
    {id: 'a', top: -100, bottom: 40},
    {id: 'b', top: 40, bottom: 400},
    {id: 'd', top: 900, bottom: 1_200},
  ]

  it('picks the first row at or below the header', () => {
    expect(chooseScrollAnchor(rows, 50, VIEWPORT)).toEqual({
      id: 'c',
      top: 400,
      order: ['a', 'b', 'c', 'd'],
      index: 2,
    })
    expect(chooseScrollAnchor(rows, 40, VIEWPORT)?.id).toBe('b')
  })

  it('picks a post under the header that fills most of the screen', () => {
    const tall = [
      {id: 'tall', top: -200, bottom: 700},
      {id: 'next', top: 700, bottom: 900},
    ]
    expect(chooseScrollAnchor(tall, 50, VIEWPORT)?.id).toBe('tall')
    // Mostly scrolled away under the header: the next post is the one read.
    expect(chooseScrollAnchor(tall, 50, 2_000)?.id).toBe('next')
  })

  it('picks the last row when every row is above the header', () => {
    expect(chooseScrollAnchor(rows, 1_300, 2_000)?.id).toBe('d')
  })

  it('has no anchor without rows', () => {
    expect(chooseScrollAnchor([], 50, VIEWPORT)).toBeUndefined()
  })

  it('keeps the anchor when it is still shown', () => {
    const anchor = chooseScrollAnchor(rows, 50, VIEWPORT)!
    expect(findAnchorTarget(anchor, () => true)).toBe('c')
  })

  it('settles on the nearest row below a hidden anchor', () => {
    const anchor = chooseScrollAnchor(rows, 50, VIEWPORT)!
    const shown = new Set(['a', 'b', 'd'])
    expect(findAnchorTarget(anchor, id => shown.has(id))).toBe('d')
  })

  it('settles on the nearest row above when none is left below', () => {
    const anchor = chooseScrollAnchor(rows, 50, VIEWPORT)!
    const shown = new Set(['a', 'b'])
    expect(findAnchorTarget(anchor, id => shown.has(id))).toBe('b')
  })

  it('finds nothing when every row is hidden', () => {
    const anchor = chooseScrollAnchor(rows, 50, VIEWPORT)!
    expect(findAnchorTarget(anchor, () => false)).toBeUndefined()
  })
})

describe('keeping the reader in place', () => {
  function node(top: number, height = 100) {
    return {
      top,
      height,
      isConnected: true,
      getBoundingClientRect() {
        return {top: this.top, height: this.height}
      },
    }
  }

  function setupRows() {
    const scrollBy = jest.fn()
    const resume = jest.fn()
    const rows = new SeenAnchorRows({
      scrollBy,
      pauseAnchoring: () => resume,
      getViewportHeight: () => 1_000,
    })
    return {rows, scrollBy, resume}
  }

  it('scrolls the anchor back to where it was', () => {
    const {rows, scrollBy, resume} = setupRows()
    const above = node(-50)
    const anchor = node(120)
    rows.register('above', above)
    rows.register('anchor', anchor)

    rows.capture(100)
    // Seen posts appear above the anchor and push it down.
    anchor.top = 520
    rows.restore()

    expect(scrollBy).toHaveBeenCalledWith(400)
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('puts the nearest remaining row where a hidden anchor was', () => {
    const {rows, scrollBy} = setupRows()
    const anchor = node(120)
    const below = node(220)
    const cleanup = rows.register('anchor', anchor)
    rows.register('below', below)

    rows.capture(100)
    cleanup()
    below.top = 20
    rows.restore()

    expect(scrollBy).toHaveBeenCalledWith(-100)
  })

  it('skips rows on a hidden page', () => {
    const {rows, scrollBy} = setupRows()
    rows.register('hidden', node(0, 0))
    rows.register('shown', node(150))

    rows.capture(100)
    rows.restore()

    expect(scrollBy).not.toHaveBeenCalled()
    expect(rows.positions()).toEqual([{id: 'shown', top: 150, bottom: 250}])
  })

  it('keeps the anchor for a second pass', () => {
    const {rows, scrollBy, resume} = setupRows()
    const anchor = node(120)
    rows.register('anchor', anchor)

    rows.capture(100)
    anchor.top = 300
    rows.restore({keep: true})
    expect(resume).not.toHaveBeenCalled()
    // An image loads above the anchor before the next frame.
    anchor.top = 140
    rows.restore()

    expect(scrollBy.mock.calls).toEqual([[180], [20]])
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('ignores nodes that cannot be measured', () => {
    const {rows} = setupRows()
    rows.register('native', {})
    expect(rows.positions()).toEqual([])
  })
})

describe('resuming past the look-back limit', () => {
  function fiveHundredPosts() {
    // One post a minute; the look-back limit is 150 minutes ago.
    return Array.from({length: 500}, (_, i) => item(i, i))
  }

  it('keeps loading past the limit after switching to showing', async () => {
    const {registry, list} = setup()
    list.add([uri(0)], NOW - 150 * MINUTE)
    const inner = timeline(fiveHundredPosts())
    const api = wrap(inner, registry)

    let data = await loadPage(api, undefined)
    let data2 = await loadPage(api, data)
    expect(data2.pages[1].cursor).toBeUndefined()
    data = data2

    switchHideSeen(ME, false, NOW)
    data = restoreSavedCursor(data)
    expect(data.pages[1].cursor).toBe('200')

    data2 = await loadPage(api, data)
    expect(inner.requests.at(-1)).toBe('200')
    expect(data2.pages[2].cursor).toBe('230')
  })

  it('ends at the limit again after switching back to hiding', async () => {
    const {registry, list} = setup()
    list.add([uri(0)], NOW - 150 * MINUTE)
    const inner = timeline(fiveHundredPosts())
    const api = wrap(inner, registry)
    let data = await loadPage(api, undefined)
    data = await loadPage(api, data)
    switchHideSeen(ME, false, NOW)
    data = restoreSavedCursor(data)
    data = await loadPage(api, data)
    const requests = inner.requests.length

    switchHideSeen(ME, true, NOW)
    data = await loadPage(api, data)

    // An empty page with no cursor, without a request.
    expect(data.pages[3]).toMatchObject({cursor: undefined, feed: []})
    expect(inner.requests.length).toBe(requests)

    // Showing again carries on from the same place.
    switchHideSeen(ME, false, NOW)
    data = restoreSavedCursor(data)
    expect(data.pages[3].cursor).toBe('230')
  })

  it('requests again when the limit has moved back', async () => {
    const {registry, list} = setup()
    list.add([uri(0)], NOW - 150 * MINUTE)
    const inner = timeline(fiveHundredPosts())
    const api = wrap(inner, registry)
    switchHideSeen(ME, false, NOW)
    let data = await loadPage(api, undefined)
    for (let i = 0; i < 5; i++) data = await loadPage(api, data)
    // A post seen even longer ago arrives, for example from sync.
    list.add([uri('older')], NOW - 400 * MINUTE)
    const requests = inner.requests.length

    switchHideSeen(ME, true, NOW + 1)
    data = await loadPage(api, data)

    expect(inner.requests.length).toBeGreaterThan(requests)
    expect(data.pages.at(-1)!.feed.length).toBeGreaterThan(0)
  })

  it('carries on when seen posts are shown while a page loads', async () => {
    const {registry, list} = setup()
    list.add([uri(0)], NOW - 150 * MINUTE)
    const inner = timeline(fiveHundredPosts())
    const api = wrap(inner, registry)
    const data = await loadPage(api, undefined)
    let release!: () => void
    inner.gate = new Promise(resolve => {
      release = resolve
    })

    const loading = loadPage(api, data)
    // The last cached page still has a cursor, so there is nothing to restore.
    expect(restoreSavedCursor(data)).toBe(data)
    switchHideSeen(ME, false, NOW)
    release()

    expect((await loading).pages[1].cursor).toBe('200')
  })

  it('does not restore a cursor from an earlier page', async () => {
    const {registry, list} = setup()
    list.add([uri(0)], NOW - 150 * MINUTE)
    const inner = timeline(Array.from({length: 230}, (_, i) => item(i, i)))
    const api = wrap(inner, registry)
    let data = await loadPage(api, undefined)
    data = await loadPage(api, data)
    switchHideSeen(ME, false, NOW)
    data = restoreSavedCursor(data)
    // Showing reaches the end of the timeline.
    data = await loadPage(api, data)
    expect(data.pages[2].cursor).toBeUndefined()

    switchHideSeen(ME, true, NOW)
    switchHideSeen(ME, false, NOW)
    expect(restoreSavedCursor(data)).toBe(data)
  })

  it('shows the Discover fallback that hiding held back', async () => {
    const {registry, list} = setup()
    list.add([uri('seen')], NOW - 300 * MINUTE)
    const marker = {
      post: {uri: 'fallback-marker-post'},
    } as unknown as app.bsky.feed.defs.FeedViewPost
    const discover = Array.from({length: 150}, (_, i) =>
      item(`discover-${i}`, i),
    )
    const inner = timeline([item('a', 1), marker, ...discover])
    const api = wrap(inner, registry)
    let data = await loadPage(api, undefined)
    expect(data.pages[0].cursor).toBeUndefined()

    switchHideSeen(ME, false, NOW)
    data = restoreSavedCursor(data)
    data = await loadPage(api, data)

    // The marker comes back with the Discover posts, without a request.
    expect(inner.requests).toEqual([undefined])
    const shown = data.pages[1].feed.map(
      f => (f as app.bsky.feed.defs.FeedViewPost).post.uri,
    )
    expect(shown.slice(0, 2)).toEqual([
      'fallback-marker-post',
      uri('discover-0'),
    ])
    expect(data.pages[1].cursor).toBe('100')

    // Hiding again cuts Discover off.
    switchHideSeen(ME, true, NOW)
    data = await loadPage(api, data)
    expect(data.pages.at(-1)).toMatchObject({cursor: undefined, feed: []})
  })

  it('leaves other feeds and empty caches alone', () => {
    const other = {cursor: undefined, api: {} as FeedAPI, feed: []}
    const data = {pages: [other], pageParams: [undefined]}
    expect(restoreSavedCursor(data)).toBe(data)
    expect(restoreSavedCursor(undefined)).toBeUndefined()
  })
})

describe('useToggleHideSeen', () => {
  beforeEach(() => {
    mockDid = `did:plc:toggle-${++didCounter}`
  })

  function renderToggle() {
    const queryClient = new QueryClient()
    const result = {} as {
      current: ReturnType<typeof useToggleHideSeen> & {
        seen: ReturnType<typeof useSeenFeed>
      }
    }
    function Probe() {
      result.current = {...useToggleHideSeen(), seen: useSeenFeed()}
      return null
    }
    render(
      <QueryClientProvider client={queryClient}>
        <SeenFeedProvider>
          <Probe />
        </SeenFeedProvider>
      </QueryClientProvider>,
    )
    return {result, queryClient}
  }

  it('switches, moves the snapshot and restores the cursor', async () => {
    const {result, queryClient} = renderToggle()
    const list = getSeenLists().get(mockDid)
    await list.ready
    list.add([uri(0)], Date.now() - 150 * MINUTE)
    const inner = timeline(
      Array.from({length: 500}, (_, i) => ({
        ...item(i, 0),
        post: {
          ...item(i, 0).post,
          indexedAt: iso(Date.now() - i * MINUTE),
        },
      })),
    )
    const api = new SeenFilteringFeedAPI(inner, mockDid)
    let data = await loadPage(api, undefined)
    data = await loadPage(api, data)
    expect(data.pages[1].cursor).toBeUndefined()
    const key = ['post-feed', 'following', {mergeFeedEnabled: false}]
    queryClient.setQueryData(key, data)

    act(() => result.current.toggle())

    expect(result.current.hideSeen).toBe(false)
    expect(queryClient.getQueryData<Cached>(key)!.pages[1].cursor).toBe('200')

    const before = Date.now()
    act(() => result.current.toggle())

    expect(result.current.hideSeen).toBe(true)
    expect(getSeenSnapshotTime(mockDid)).toBeGreaterThanOrEqual(before)
  })
})
