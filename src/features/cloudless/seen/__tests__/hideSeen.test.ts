import {AppState} from 'react-native'

import {type FeedAPI} from '#/lib/api/feed/types'
import {FeedTuner} from '#/lib/api/feed-manip'
import {pollLatest} from '#/state/queries/post-feed'
import {
  getSeenSnapshotTime,
  resetSeenFeedStateForTests,
  setHideSeen,
  setSeenSnapshotTime,
} from '#/features/cloudless/seen/feedState'
import {
  SeenFilteringFeedAPI,
  withSeenFiltering,
} from '#/features/cloudless/seen/SeenFilteringFeedAPI'
import {SeenListRegistry} from '#/features/cloudless/seen/seenList'
import {
  createHideSeenTuner,
  isHideSeenTuner,
} from '#/features/cloudless/seen/tuner'
import {type app} from '#/lexicons'

// The app-wide mock of `multiformats/cid` rejects the reply refs' CIDs.
jest.unmock('multiformats/cid')
// `post-feed` is imported for `pollLatest`; these keep its UI imports out.
jest.mock('#/state/preferences/feed-tuners', () => ({
  useFeedTuners: jest.fn(),
}))
jest.mock('#/state/preferences/moderation-opts', () => ({
  useModerationOpts: jest.fn(),
}))
jest.mock('#/state/queries/preferences', () => ({
  usePreferencesQuery: jest.fn(),
}))
jest.mock('#/state/session', () => ({
  useAppviewClient: jest.fn(),
  useSession: jest.fn(),
}))
jest.mock('#/view/com/posts/PostFeedErrorMessage', () => ({
  KnownError: {},
}))

const ME = 'did:plc:me'
const CID = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm'

const author = {
  $type: 'app.bsky.actor.defs#profileViewBasic',
  did: 'did:plc:alice',
  handle: 'alice.test',
} satisfies app.bsky.actor.defs.ProfileViewBasic

function uri(id: string) {
  return `at://did:plc:alice/app.bsky.feed.post/${id}` as const
}

function post(
  id: string,
  reply?: {root: string; parent: string},
): app.bsky.feed.defs.PostView & {$type: 'app.bsky.feed.defs#postView'} {
  return {
    $type: 'app.bsky.feed.defs#postView',
    uri: uri(id),
    cid: CID,
    author,
    record: {
      $type: 'app.bsky.feed.post',
      text: id,
      createdAt: '2026-08-31T00:00:00.000Z',
      ...(reply
        ? {
            reply: {
              root: {uri: uri(reply.root), cid: CID},
              parent: {uri: uri(reply.parent), cid: CID},
            },
          }
        : {}),
    },
    indexedAt: '2026-08-31T00:00:00.000Z',
  }
}

function single(id: string): app.bsky.feed.defs.FeedViewPost {
  return {post: post(id)}
}

/**
 * A reply shown with its parent and root: root <- parent <- reply.
 */
function replyUnit(id: string): app.bsky.feed.defs.FeedViewPost {
  const root = post(`${id}-root`)
  const parent = post(`${id}-parent`, {
    root: `${id}-root`,
    parent: `${id}-root`,
  })
  return {
    post: post(id, {root: `${id}-root`, parent: `${id}-parent`}),
    reply: {root, parent},
  }
}

function repost(id: string, by: string): app.bsky.feed.defs.FeedViewPost {
  return {
    post: post(id),
    reason: {
      $type: 'app.bsky.feed.defs#reasonRepost',
      by: {...author, did: `did:plc:${by}`, handle: `${by}.test`},
      indexedAt: '2026-09-01T00:00:00.000Z',
    },
  }
}

let clock = 1_000

function createList() {
  const registry = new SeenListRegistry({
    storage: null,
    channel: null,
    now: () => clock,
    limit: 100,
    flushIntervalMs: 60_000,
    loadTimeoutMs: 1_000,
  })
  return {registry, list: registry.get(ME)}
}

function tune(
  registry: SeenListRegistry,
  feed: app.bsky.feed.defs.FeedViewPost[],
) {
  const tuner = new FeedTuner([createHideSeenTuner(ME, undefined, registry)])
  return tuner.tune(feed).map(slice => slice.items.map(i => i.post.uri))
}

beforeEach(() => {
  resetSeenFeedStateForTests()
  clock = 1_000
})

describe('hiding tuner', () => {
  it('removes posts seen as of the snapshot and keeps the rest', () => {
    const {registry, list} = createList()
    list.add([uri('a')], clock)
    setSeenSnapshotTime(ME, 2_000)

    expect(tune(registry, [single('a'), single('b')])).toEqual([[uri('b')]])
  })

  it('keeps posts seen after the snapshot, so nothing vanishes mid-scroll', () => {
    const {registry, list} = createList()
    setSeenSnapshotTime(ME, 2_000)
    clock = 3_000
    list.add([uri('a')], clock)

    expect(tune(registry, [single('a')])).toEqual([[uri('a')]])
  })

  it('hides nothing before the first snapshot', () => {
    const {registry, list} = createList()
    list.add([uri('a')], clock)

    expect(tune(registry, [single('a')])).toEqual([[uri('a')]])
  })

  it('keeps an unseen reply with its seen parent and root', () => {
    const {registry, list} = createList()
    list.add([uri('r-root'), uri('r-parent')], clock)
    setSeenSnapshotTime(ME, 2_000)

    expect(tune(registry, [replyUnit('r')])).toEqual([
      [uri('r-root'), uri('r-parent'), uri('r')],
    ])
  })

  it('removes a seen reply together with its context', () => {
    const {registry, list} = createList()
    list.add([uri('r')], clock)
    setSeenSnapshotTime(ME, 2_000)

    expect(tune(registry, [replyUnit('r'), single('b')])).toEqual([[uri('b')]])
  })

  it('removes a repost of a seen post', () => {
    const {registry, list} = createList()
    list.add([uri('a')], clock)
    setSeenSnapshotTime(ME, 2_000)

    expect(tune(registry, [repost('a', 'carol'), single('b')])).toEqual([
      [uri('b')],
    ])
  })

  it('applies the snapshot set while a page is loading', () => {
    // The tuner reads the snapshot when it runs, not when it was made.
    const {registry, list} = createList()
    const tuner = new FeedTuner([createHideSeenTuner(ME, undefined, registry)])
    list.add([uri('a')], clock)
    setSeenSnapshotTime(ME, 2_000)

    expect(tuner.tune([single('a')])).toEqual([])
  })
})

function fakeApi(
  latest: app.bsky.feed.defs.FeedViewPost | undefined,
): FeedAPI & {fetch: jest.Mock} {
  return {
    peekLatest: jest.fn(() => Promise.resolve(latest!)),
    fetch: jest.fn(() =>
      Promise.resolve({cursor: 'next', feed: [single('x')]}),
    ),
  }
}

describe('SeenFilteringFeedAPI', () => {
  it('sets the snapshot once the first page arrives', async () => {
    const {registry} = createList()
    const api = new SeenFilteringFeedAPI(
      fakeApi(undefined),
      ME,
      registry,
      () => 5_000,
    )

    const res = await api.fetch({cursor: undefined, limit: 30})

    expect(res.feed).toHaveLength(1)
    expect(getSeenSnapshotTime(ME)).toBe(5_000)
  })

  it('leaves the snapshot alone for later pages', async () => {
    const {registry} = createList()
    setSeenSnapshotTime(ME, 4_000)
    const api = new SeenFilteringFeedAPI(
      fakeApi(undefined),
      ME,
      registry,
      () => 5_000,
    )

    await api.fetch({cursor: 'next', limit: 30})

    expect(getSeenSnapshotTime(ME)).toBe(4_000)
  })

  it('keeps every fetched post, seen or not', async () => {
    const {registry, list} = createList()
    list.add([uri('x')], clock)
    const api = new SeenFilteringFeedAPI(fakeApi(undefined), ME, registry)

    const res = await api.fetch({cursor: undefined, limit: 30})

    expect(res.feed.map(f => f.post.uri)).toEqual([uri('x')])
  })

  describe('"new posts" check', () => {
    function page(api: FeedAPI, registry: SeenListRegistry) {
      return {
        api,
        tuner: new FeedTuner([createHideSeenTuner(ME, undefined, registry)]),
        cursor: undefined,
        slices: [],
        fetchedAt: 0,
      }
    }

    beforeEach(() => {
      // `pollLatest` only polls while the app is in the foreground.
      Object.defineProperty(AppState, 'currentState', {
        value: 'active',
        configurable: true,
      })
    })

    it('reports nothing new when the newest post is seen', async () => {
      const {registry, list} = createList()
      const api = new SeenFilteringFeedAPI(fakeApi(single('new')), ME, registry)
      // Seen after the snapshot, so a dry-run tune alone would keep it.
      setSeenSnapshotTime(ME, 500)
      list.add([uri('new')], clock)

      expect(await pollLatest(page(api, registry))).toBe(false)
    })

    it('reports a new post when the newest post is unseen', async () => {
      const {registry} = createList()
      const api = new SeenFilteringFeedAPI(fakeApi(single('new')), ME, registry)

      expect(await pollLatest(page(api, registry))).toBe(true)
    })

    it('reports a seen post as new while seen posts are shown', async () => {
      const {registry, list} = createList()
      const api = new SeenFilteringFeedAPI(fakeApi(single('new')), ME, registry)
      list.add([uri('new')], clock)
      setHideSeen(false)

      expect(await api.peekLatest()).toEqual(single('new'))
    })
  })
})

describe('withSeenFiltering', () => {
  const create = jest.fn((_args: unknown) => fakeApi(undefined))

  beforeEach(() => create.mockClear())

  it('wraps the Following feed and keeps the hiding tuner from it', () => {
    const {registry} = createList()
    const hide = createHideSeenTuner(ME, undefined, registry)
    const api = withSeenFiltering(
      {
        feedDesc: 'following',
        client: {did: ME},
        feedTuners: [FeedTuner.dedupThreads, hide],
      },
      create,
    )

    expect(api).toBeInstanceOf(SeenFilteringFeedAPI)
    expect(create.mock.calls[0][0]).toMatchObject({
      feedTuners: [FeedTuner.dedupThreads],
    })
    expect(isHideSeenTuner(hide)).toBe(true)
  })

  it.each([
    'feedgen|at://did:plc:x/app.bsky.feed.generator/y',
    'author|did:plc:alice|posts_and_author_threads',
    'list|at://did:plc:x/app.bsky.graph.list/y',
  ])('leaves %s untouched', feedDesc => {
    const args = {feedDesc, client: {did: ME}, feedTuners: []}
    const api = withSeenFiltering(args, create)

    expect(api).not.toBeInstanceOf(SeenFilteringFeedAPI)
    expect(create).toHaveBeenCalledWith(args)
  })

  it('leaves Following untouched when signed out', () => {
    const api = withSeenFiltering(
      {feedDesc: 'following', client: {did: undefined}, feedTuners: []},
      create,
    )

    expect(api).not.toBeInstanceOf(SeenFilteringFeedAPI)
  })
})
