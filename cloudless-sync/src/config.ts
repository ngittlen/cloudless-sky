export type Config = {
  /**
   * The address to listen on. Defaults to loopback, so a service started by
   * hand is never reachable from the network. The container listens on all
   * of its interfaces and Compose publishes the port on the host's loopback.
   */
  host: string
  port: number
  /**
   * The SQLite file. Its directory is created if missing.
   */
  dbPath: string
  /**
   * Allows CORS from `http://localhost:*` and logs every request. Never set
   * in production.
   */
  dev: boolean
}

export const DEFAULT_PORT = 8101

function isTruthy(value: string | undefined) {
  return value === '1' || value === 'true'
}

export function readConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv.slice(2),
): Config {
  const port = Number(env.CLOUDLESS_SYNC_PORT ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(
      `CLOUDLESS_SYNC_PORT is not a port: ${env.CLOUDLESS_SYNC_PORT}`,
    )
  }
  return {
    host: env.CLOUDLESS_SYNC_HOST || '127.0.0.1',
    port,
    dbPath: env.CLOUDLESS_SYNC_DB || 'data/seen.sqlite',
    dev: isTruthy(env.CLOUDLESS_SYNC_DEV) || argv.includes('--dev'),
  }
}
