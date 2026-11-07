import {resolveSyncBaseUrl} from '../config'

describe('resolveSyncBaseUrl', () => {
  it('defaults to /sync on the same origin in production', () => {
    expect(
      resolveSyncBaseUrl({configured: undefined, isDev: false, isWeb: true}),
    ).toBe('/sync')
  })

  it('is off in development unless a URL is set', () => {
    expect(
      resolveSyncBaseUrl({configured: undefined, isDev: true, isWeb: true}),
    ).toBeUndefined()
    expect(
      resolveSyncBaseUrl({configured: '  ', isDev: true, isWeb: true}),
    ).toBeUndefined()
    expect(
      resolveSyncBaseUrl({
        configured: 'http://localhost:8101/sync/',
        isDev: true,
        isWeb: true,
      }),
    ).toBe('http://localhost:8101/sync')
  })

  it('uses a configured URL in production', () => {
    expect(
      resolveSyncBaseUrl({
        configured: 'https://example.test/sync',
        isDev: false,
        isWeb: true,
      }),
    ).toBe('https://example.test/sync')
  })

  it('is off outside the web', () => {
    expect(
      resolveSyncBaseUrl({configured: '/sync', isDev: false, isWeb: false}),
    ).toBeUndefined()
  })
})
