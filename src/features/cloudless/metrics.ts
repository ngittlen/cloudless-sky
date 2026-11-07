import {type MetricsClient} from '#/analytics/metrics/client'

/**
 * Usage metrics go only to a host set explicitly with
 * `EXPO_PUBLIC_METRICS_API_HOST`. Without one, upstream falls back to
 * Bluesky's `https://events.bsky.app`, and a private copy must not report to
 * Bluesky as if it were the official app, so Cloudless Sky sends nothing.
 *
 * Feature flags are separate: with no metrics host set,
 * `GROWTHBOOK_API_HOST` defaults to `https://events.bsky.app/gb` and keeps
 * working. Setting a metrics host also moves that default to
 * `<metrics host>/gb`, so set `EXPO_PUBLIC_GROWTHBOOK_API_HOST` alongside it.
 */
export const IS_METRICS_ENABLED = !!process.env.EXPO_PUBLIC_METRICS_API_HOST

/**
 * The client's private method that every send goes through (`fetch` or
 * `navigator.sendBeacon`).
 */
type Sender = {sendBatch: (...args: unknown[]) => Promise<void>}

/**
 * Applies the fork's metrics policy to the shared client. With metrics off,
 * `track` drops every event, so the client never queues one or starts its
 * flush timer, and the send path is a no-op as a backstop for any other way
 * events could reach it.
 */
export function applyMetricsPolicy<M extends Record<string, unknown>>(
  client: MetricsClient<M>,
  enabled: boolean = IS_METRICS_ENABLED,
): MetricsClient<M> {
  if (!enabled) {
    client.track = () => {}
    ;(client as unknown as Sender).sendBatch = async () => {}
  }
  return client
}
