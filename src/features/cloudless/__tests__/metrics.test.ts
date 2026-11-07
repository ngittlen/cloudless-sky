import {MetricsClient} from '#/analytics/metrics/client'
import {applyMetricsPolicy} from '#/features/cloudless/metrics'

jest.mock('#/lib/appState', () => ({
  onAppStateChange: jest.fn(() => ({remove: jest.fn()})),
}))

jest.mock('#/logger', () => ({
  Logger: {
    create: () => ({
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    }),
    Context: {Metric: 'metric'},
  },
}))

jest.mock('#/env', () => ({
  METRICS_API_HOST: 'https://events.example',
  IS_WEB: false,
}))

type TestEvents = {
  click: {button: string}
}

describe('applyMetricsPolicy', () => {
  let fetchMock: jest.Mock

  beforeEach(() => {
    jest.useFakeTimers()
    fetchMock = jest.fn().mockResolvedValue({ok: true})
    global.fetch = fetchMock
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('sends nothing when metrics are off', () => {
    const client = applyMetricsPolicy(new MetricsClient<TestEvents>(), false)

    // More than one batch, which would flush immediately if tracked.
    for (let i = 0; i <= client.maxBatchSize + 1; i++) {
      client.track('click', {button: 'like'})
    }
    jest.advanceTimersByTime(60_000)
    client.flush()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('drops events that reach the send path some other way', async () => {
    const client = applyMetricsPolicy(new MetricsClient<TestEvents>(), false)

    // Simulates a send path that bypasses `track`.
    ;(client as unknown as {queue: unknown[]}).queue.push({event: 'click'})
    client.flush()
    await Promise.resolve()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  /*
   * Tripwire: the policy covers the methods below. When upstream adds or
   * renames a MetricsClient method, this fails so the policy can be checked
   * for a new way to send events.
   */
  it('covers every MetricsClient method', () => {
    const methods = Object.getOwnPropertyNames(MetricsClient.prototype).sort()
    expect(methods).toEqual([
      'constructor',
      'flush',
      'retryFailedLogs',
      'sendBatch',
      'start',
      'track',
      'trim',
    ])
  })

  it('leaves the client unchanged when metrics are on', () => {
    const client = applyMetricsPolicy(new MetricsClient<TestEvents>(), true)

    client.track('click', {button: 'like'})
    client.flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://events.example/t',
      expect.objectContaining({method: 'POST'}),
    )
  })

  it('is off by default when no metrics host is configured', () => {
    jest.isolateModules(() => {
      const previous = process.env.EXPO_PUBLIC_METRICS_API_HOST
      delete process.env.EXPO_PUBLIC_METRICS_API_HOST
      try {
        const {IS_METRICS_ENABLED} =
          require('#/features/cloudless/metrics') as typeof import('#/features/cloudless/metrics')
        expect(IS_METRICS_ENABLED).toBe(false)
      } finally {
        if (previous !== undefined) {
          process.env.EXPO_PUBLIC_METRICS_API_HOST = previous
        }
      }
    })
  })
})
