import {IS_WEB} from '#/env'

/**
 * Where the sync service is, without a trailing slash, or `undefined` when
 * sync is off.
 *
 * - `EXPO_PUBLIC_CLOUDLESS_SYNC_URL`, when set, wins.
 * - Production web builds default to `/sync` on the app's own origin, where
 *   Tailscale Serve routes it to the service.
 * - Development builds (`pnpm web`) run on another origin, so sync is off
 *   unless the URL is set, for example to a local service in dev mode.
 * - Native builds never sync.
 */
export function resolveSyncBaseUrl({
  configured,
  isDev,
  isWeb,
}: {
  configured: string | undefined
  isDev: boolean
  isWeb: boolean
}): string | undefined {
  if (!isWeb) return undefined
  const url = configured?.trim()
  if (url) return url.replace(/\/+$/, '')
  return isDev ? undefined : '/sync'
}

export function getSyncBaseUrl(): string | undefined {
  return resolveSyncBaseUrl({
    configured: process.env.EXPO_PUBLIC_CLOUDLESS_SYNC_URL,
    isDev: __DEV__,
    isWeb: IS_WEB,
  })
}
