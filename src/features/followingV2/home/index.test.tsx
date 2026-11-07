import {render, screen} from '@testing-library/react-native'

import {HomeScreen} from '.'

const mockEnabled = jest.fn()
let mockIsNative = true

jest.mock('#/env', () => ({
  get IS_NATIVE() {
    return mockIsNative
  },
  get IS_WEB() {
    return !mockIsNative
  },
}))

jest.mock('#/analytics', () => ({
  useAnalytics: () => ({
    features: {
      enabled: mockEnabled,
      FollowingV2Enable: 'following_v2:enable',
    },
  }),
}))

jest.mock('#/view/screens/Home', () => {
  const {Text} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {HomeScreen: () => <Text>legacy home</Text>}
})

jest.mock('./Home', () => {
  const {Text} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {HomeScreen: () => <Text>following v2 home</Text>}
})

const props = {} as React.ComponentProps<typeof HomeScreen>

describe.each([
  {platform: 'native', isNative: true},
  {platform: 'web', isNative: false},
])('HomeScreen on $platform', ({isNative}) => {
  beforeEach(() => {
    mockEnabled.mockReset()
    mockIsNative = isNative
  })

  // Cloudless Sky pins the legacy home, which hiding seen posts hooks into.
  it('renders the legacy home even when following v2 is enabled', () => {
    mockEnabled.mockReturnValue(true)

    render(<HomeScreen {...props} />)

    expect(screen.getByText('legacy home')).toBeTruthy()
    expect(screen.queryByText('following v2 home')).toBeNull()
  })

  it('renders the legacy home when following v2 is disabled', () => {
    mockEnabled.mockReturnValue(false)

    render(<HomeScreen {...props} />)

    expect(screen.getByText('legacy home')).toBeTruthy()
    expect(screen.queryByText('following v2 home')).toBeNull()
  })
})
