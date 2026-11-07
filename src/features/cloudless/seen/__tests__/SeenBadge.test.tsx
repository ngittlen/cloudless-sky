import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {act, render, renderHook, screen} from '@testing-library/react-native'

import {FeedTuner} from '#/lib/api/feed-manip'
import {SeenFeedProvider} from '#/features/cloudless/seen/context'
import {
  resetSeenFeedStateForTests,
  setSeenSnapshotTime,
  switchHideSeen,
} from '#/features/cloudless/seen/feedState'
import {PostMetaRow} from '#/features/cloudless/seen/PostMetaRow'
import {
  SeenBadge,
  type SeenBadgeState,
  shouldShowSeenBadge,
  useSeenBadgeFor,
} from '#/features/cloudless/seen/SeenBadge'
import {
  getSeenLists,
  SeenListRegistry,
} from '#/features/cloudless/seen/seenList'
import {type app} from '#/lexicons'

// The app-wide mock of `multiformats/cid` rejects the reply refs' CIDs.
jest.unmock('multiformats/cid')
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: {did: mockDid}}),
}))
// The design system needs native modules; the badge's text does not.
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({atoms: new Proxy({}, {get: () => ({})})}),
}))
jest.mock('#/components/Typography', () => ({
  Text: jest.requireActual<typeof import('react-native')>('react-native').Text,
}))

const ME = 'did:plc:me'
const CID = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm'

let mockDid = 'did:plc:badge-1'
let didCounter = 1

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

/**
 * The feed's units, as the Following feed's rows are built from them.
 */
function slices(feed: app.bsky.feed.defs.FeedViewPost[]) {
  return new FeedTuner([]).tune(feed)
}

let clock = 1_000

function setup(overrides: Partial<SeenBadgeState> = {}) {
  const registry = new SeenListRegistry({
    storage: null,
    channel: null,
    now: () => clock,
    limit: 100,
    flushIntervalMs: 60_000,
    loadTimeoutMs: 1_000,
  })
  const list = registry.get(ME)
  const state = (): SeenBadgeState => ({
    feed: 'following',
    hideSeen: false,
    snapshotTime: 2_000,
    list,
    ...overrides,
  })
  return {list, state}
}

beforeAll(() => {
  i18n.loadAndActivate({locale: 'en', messages: {}})
})

beforeEach(() => {
  clock = 1_000
  mockDid = `did:plc:badge-${++didCounter}`
  act(() => resetSeenFeedStateForTests())
})

describe('which posts get a badge', () => {
  it('badges a seen post and not an unseen one', () => {
    const {list, state} = setup()
    list.add([uri('a')], clock)
    const [a, b] = slices([single('a'), single('b')])

    expect(shouldShowSeenBadge(state(), a)).toBe(true)
    expect(shouldShowSeenBadge(state(), b)).toBe(false)
  })

  it('badges every post in a seen reply unit', () => {
    const {list, state} = setup()
    list.add([uri('r-root'), uri('r-parent'), uri('r')], clock)
    const [unit] = slices([replyUnit('r')])

    // Every row of the unit is rendered from the same slice.
    expect(unit.items).toHaveLength(3)
    expect(shouldShowSeenBadge(state(), unit)).toBe(true)
  })

  it('badges nothing in an unseen reply with seen context', () => {
    const {list, state} = setup()
    list.add([uri('r-root'), uri('r-parent')], clock)
    const [unit] = slices([replyUnit('r')])

    expect(unit.items).toHaveLength(3)
    expect(shouldShowSeenBadge(state(), unit)).toBe(false)
  })

  it('badges a repost of a seen post', () => {
    const {list, state} = setup()
    list.add([uri('a')], clock)
    const [reposted] = slices([repost('a', 'carol')])

    expect(shouldShowSeenBadge(state(), reposted)).toBe(true)
  })

  it('badges nothing while seen posts are hidden', () => {
    const {list, state} = setup({hideSeen: true})
    list.add([uri('a')], clock)
    const [a] = slices([single('a')])

    expect(shouldShowSeenBadge(state(), a)).toBe(false)
  })

  it('does not badge a post seen after the snapshot', () => {
    const {list, state} = setup()
    clock = 3_000
    list.add([uri('a')], clock)
    const [a] = slices([single('a')])

    expect(shouldShowSeenBadge(state(), a)).toBe(false)
  })

  it('badges nothing in other feeds', () => {
    const {list, state} = setup({feed: 'author|did:plc:alice|posts_no_replies'})
    list.add([uri('a')], clock)
    const [a] = slices([single('a')])

    expect(shouldShowSeenBadge(state(), a)).toBe(false)
  })

  it('badges nothing before the feed has loaded', () => {
    const {list, state} = setup({snapshotTime: undefined})
    list.add([uri('a')], clock)
    const [a] = slices([single('a')])

    expect(shouldShowSeenBadge(state(), a)).toBe(false)
  })
})

describe('useSeenBadgeFor', () => {
  function renderBadgeFor(feed: string) {
    return renderHook(() => useSeenBadgeFor(feed), {
      wrapper: ({children}) => <SeenFeedProvider>{children}</SeenFeedProvider>,
    })
  }

  it('gives seen units a badge while seen posts are shown', () => {
    const list = getSeenLists().get(mockDid)
    list.add([uri('a')], Date.now() - 1_000)
    const [a, b] = slices([single('a'), single('b')])
    act(() => setSeenSnapshotTime(mockDid, Date.now()))
    const {result} = renderBadgeFor('following')

    expect(result.current(a)).toBeUndefined()

    act(() => switchHideSeen(mockDid, false, Date.now()))

    expect(result.current(a)).not.toBeUndefined()
    expect(result.current(b)).toBeUndefined()
  })

  it('updates badges when the toggle switches, not while scrolling', () => {
    const list = getSeenLists().get(mockDid)
    const [a] = slices([single('a')])
    act(() => switchHideSeen(mockDid, false, Date.now() - 1_000))
    const {result} = renderBadgeFor('following')

    // Scrolled past after the snapshot.
    list.add([uri('a')], Date.now())
    expect(result.current(a)).toBeUndefined()

    act(() => switchHideSeen(mockDid, true, Date.now() + 1))
    act(() => switchHideSeen(mockDid, false, Date.now() + 2))
    expect(result.current(a)).not.toBeUndefined()
  })

  it('badges once the seen list loads after the first render', () => {
    // Seen posts were left shown; the app opens before the list exists.
    act(() => switchHideSeen(mockDid, false, 0))
    expect(getSeenLists().peek(mockDid)).toBeUndefined()
    const {result} = renderBadgeFor('following')

    const list = getSeenLists().get(mockDid)
    list.add([uri('a')], Date.now())
    // The first page arrives and moves the snapshot.
    act(() => setSeenSnapshotTime(mockDid, Date.now() + 1))
    const [a] = slices([single('a')])

    expect(result.current(a)).not.toBeUndefined()
  })

  it('never badges other feeds', () => {
    const list = getSeenLists().get(mockDid)
    list.add([uri('a')], Date.now() - 1_000)
    act(() => switchHideSeen(mockDid, false, Date.now()))
    const [a] = slices([single('a')])
    const {result} = renderBadgeFor('feedgen|at://did:plc:x/feed/y')

    expect(result.current(a)).toBeUndefined()
  })
})

describe('the badge', () => {
  it('reads "Seen"', () => {
    render(
      <I18nProvider i18n={i18n}>
        <SeenBadge />
      </I18nProvider>,
    )
    expect(screen.getByText('Seen')).toBeTruthy()
  })

  it('sits after the top line only when given', () => {
    const {Text} =
      jest.requireActual<typeof import('react-native')>('react-native')
    const {toJSON, rerender} = render(
      <PostMetaRow>
        <Text>meta</Text>
      </PostMetaRow>,
    )
    // Without an accessory, the top line is not wrapped.
    expect(toJSON()).toMatchObject({type: 'Text'})

    rerender(
      <PostMetaRow accessory={<Text>badge</Text>}>
        <Text>meta</Text>
      </PostMetaRow>,
    )
    expect(toJSON()).toMatchObject({
      type: 'View',
      children: [{children: ['meta']}, {children: ['badge']}],
    })
  })
})
