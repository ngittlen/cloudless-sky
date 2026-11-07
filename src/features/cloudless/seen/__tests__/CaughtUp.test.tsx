import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {act, render, screen} from '@testing-library/react-native'

import {
  FollowingEmptyStateOrCaughtUp,
  FollowingEndOfFeedOrCaughtUp,
} from '#/features/cloudless/seen/CaughtUp'
import {SeenFeedProvider} from '#/features/cloudless/seen/context'
import {
  resetSeenFeedStateForTests,
  setHideSeen,
  setSeenSnapshotTime,
} from '#/features/cloudless/seen/feedState'
import {getSeenLists} from '#/features/cloudless/seen/seenList'

jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: {did: mockDid}}),
}))
jest.mock('#/view/com/posts/FollowingEmptyState', () => {
  const {Text: MockText} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {FollowingEmptyState: () => <MockText>official empty</MockText>}
})
jest.mock('#/view/com/posts/FollowingEndOfFeed', () => {
  const {Text: MockText} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {FollowingEndOfFeed: () => <MockText>official end</MockText>}
})

// The design system needs native modules; the decision under test does not.
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({atoms: new Proxy({}, {get: () => ({})})}),
}))
jest.mock('#/components/icons/CircleCheck', () => ({
  CircleCheck_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/Typography', () => ({
  Text: jest.requireActual<typeof import('react-native')>('react-native').Text,
}))

let mockDid = 'did:plc:caught-up-1'
let didCounter = 1

function renderWith(element: React.ReactElement) {
  return render(
    <I18nProvider i18n={i18n}>
      <SeenFeedProvider>{element}</SeenFeedProvider>
    </I18nProvider>,
  )
}

beforeAll(() => {
  i18n.loadAndActivate({locale: 'en', messages: {}})
})

beforeEach(() => {
  // A fresh account per test keeps the shared seen lists apart.
  mockDid = `did:plc:caught-up-${++didCounter}`
  act(() => resetSeenFeedStateForTests())
})

function seeSomething() {
  getSeenLists().get(mockDid).add(['at://did:plc:x/app.bsky.feed.post/1'], 1)
  act(() => setSeenSnapshotTime(mockDid, Date.now()))
}

describe.each([
  ['empty state', FollowingEmptyStateOrCaughtUp, 'official empty'],
  ['end of feed', FollowingEndOfFeedOrCaughtUp, 'official end'],
])('%s', (_name, Component, official) => {
  it('says caught up while seen posts are hidden', () => {
    seeSomething()
    renderWith(<Component />)

    expect(screen.getByTestId('cloudlessCaughtUp')).toBeTruthy()
    expect(screen.queryByText(official)).toBeNull()
  })

  it('shows the official message with an empty seen list', () => {
    act(() => setSeenSnapshotTime(mockDid, Date.now()))
    renderWith(<Component />)

    expect(screen.getByText(official)).toBeTruthy()
  })

  it('shows the official message while seen posts are shown', () => {
    seeSomething()
    act(() => setHideSeen(false))
    renderWith(<Component />)

    expect(screen.getByText(official)).toBeTruthy()
  })

  it('shows the official message before the feed has loaded', () => {
    getSeenLists().get(mockDid).add(['at://did:plc:x/app.bsky.feed.post/1'], 1)
    renderWith(<Component />)

    expect(screen.getByText(official)).toBeTruthy()
  })
})
