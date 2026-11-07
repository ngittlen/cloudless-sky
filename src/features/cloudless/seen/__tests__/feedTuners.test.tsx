import {act, renderHook} from '@testing-library/react-native'

import {useFeedTuners} from '#/state/preferences/feed-tuners'
import {SeenFeedProvider} from '#/features/cloudless/seen/context'
import {
  resetSeenFeedStateForTests,
  setHideSeen,
  setSeenSnapshotTime,
} from '#/features/cloudless/seen/feedState'
import {isHideSeenTuner} from '#/features/cloudless/seen/tuner'

jest.mock('#/state/preferences/languages', () => ({
  useLanguagePrefs: () => ({contentLanguages: []}),
}))
jest.mock('#/state/queries/preferences', () => ({
  usePreferencesQuery: () => ({data: {feedViewPrefs: {}}}),
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: {did: 'did:plc:me'}}),
}))

const ME = 'did:plc:me'

function withProvider({children}: {children: React.ReactNode}) {
  return <SeenFeedProvider>{children}</SeenFeedProvider>
}

function hidingTuners(tuners: unknown[]) {
  return tuners.filter(fn => isHideSeenTuner(fn as never))
}

beforeEach(() => {
  resetSeenFeedStateForTests()
})

describe('useFeedTuners with hiding', () => {
  it('adds the hiding tuner last for Following', () => {
    const {result} = renderHook(() => useFeedTuners('following'), {
      wrapper: withProvider,
    })

    expect(hidingTuners(result.current)).toHaveLength(1)
    expect(isHideSeenTuner(result.current.at(-1)!)).toBe(true)
  })

  it.each([
    'list|at://did:plc:x/app.bsky.graph.list/y',
    'feedgen|at://did:plc:x/app.bsky.feed.generator/y',
    'author|did:plc:alice|posts_and_author_threads',
  ] as const)('leaves %s untouched', feedDesc => {
    const {result} = renderHook(() => useFeedTuners(feedDesc), {
      wrapper: withProvider,
    })

    expect(hidingTuners(result.current)).toHaveLength(0)
  })

  it('adds nothing outside the provider', () => {
    const {result} = renderHook(() => useFeedTuners('following'))

    expect(hidingTuners(result.current)).toHaveLength(0)
  })

  it('adds nothing while seen posts are shown', () => {
    setHideSeen(false)
    const {result} = renderHook(() => useFeedTuners('following'), {
      wrapper: withProvider,
    })

    expect(hidingTuners(result.current)).toHaveLength(0)
  })

  it('keeps the same tuners until the snapshot time changes', () => {
    const {result, rerender} = renderHook(() => useFeedTuners('following'), {
      wrapper: withProvider,
    })
    const first = result.current
    rerender({})
    expect(result.current).toBe(first)

    act(() => setSeenSnapshotTime(ME, 5_000))
    rerender({})
    expect(result.current).not.toBe(first)
  })
})
