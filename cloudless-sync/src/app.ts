import compression from 'compression'
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express'

import {
  MAX_BATCH_SIZE,
  MAX_BODY_BYTES,
  MAX_DID_LENGTH,
  MAX_URI_LENGTH,
} from './constants.ts'
import {InvalidPositionError, type SeenEntry, type SeenStore} from './store.ts'

export class InvalidRequestError extends Error {}

export type Logger = {
  info(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

/**
 * Origins allowed in dev mode: the app's local dev server and test pages on
 * any port.
 */
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/

function isDid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('did:') &&
    value.length > 4 &&
    value.length <= MAX_DID_LENGTH
  )
}

function parseDid(value: unknown): string {
  if (!isDid(value)) {
    throw new InvalidRequestError('did must be a string starting with "did:"')
  }
  return value
}

/**
 * The body of `POST /seen`: `{did, entries: [{uri, seenAt}]}`. Any invalid
 * entry rejects the whole batch, so nothing from a malformed request is
 * stored.
 */
export function parseSeenBatch(body: unknown): {
  did: string
  entries: SeenEntry[]
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidRequestError('body must be a JSON object')
  }
  const {did, entries} = body as {did?: unknown; entries?: unknown}
  const parsedDid = parseDid(did)
  if (!Array.isArray(entries)) {
    throw new InvalidRequestError('entries must be an array')
  }
  if (entries.length > MAX_BATCH_SIZE) {
    throw new InvalidRequestError(
      `entries holds ${entries.length} items; the most per request is ${MAX_BATCH_SIZE}`,
    )
  }
  const parsed: SeenEntry[] = []
  entries.forEach((entry: unknown, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new InvalidRequestError(`entries[${i}] must be an object`)
    }
    const {uri, seenAt} = entry as {uri?: unknown; seenAt?: unknown}
    if (
      typeof uri !== 'string' ||
      !uri.startsWith('at://') ||
      uri.length > MAX_URI_LENGTH
    ) {
      throw new InvalidRequestError(
        `entries[${i}].uri must be a string starting with "at://"`,
      )
    }
    if (
      typeof seenAt !== 'number' ||
      !Number.isSafeInteger(seenAt) ||
      seenAt < 0
    ) {
      throw new InvalidRequestError(
        `entries[${i}].seenAt must be a non-negative integer (milliseconds since the epoch)`,
      )
    }
    parsed.push({uri, seenAt})
  })
  return {did: parsedDid, entries: parsed}
}

function parseOptionalString(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') {
    throw new InvalidRequestError(`${name} must be given once, as a string`)
  }
  return value
}

/**
 * The query of `GET /seen`: `did`, and optionally `since` (a `serverTime`
 * from an earlier response) and `cursor` (from the previous page).
 */
export function parseChangesQuery(query: Record<string, unknown>): {
  did: string
  since: number
  cursor: string | undefined
} {
  const did = parseDid(query.did)
  const sinceText = parseOptionalString(query.since, 'since')
  let since = 0
  if (sinceText !== undefined) {
    since = Number(sinceText)
    if (!/^\d+$/.test(sinceText) || !Number.isSafeInteger(since)) {
      throw new InvalidRequestError(
        'since must be a serverTime from an earlier response',
      )
    }
  }
  const cursor = parseOptionalString(query.cursor, 'cursor')
  return {did, since, cursor}
}

/**
 * In dev mode the app's local dev server runs on another origin, so the
 * service answers CORS requests from `http://localhost:*`. Production serves
 * the app and the service from one origin and never sets dev mode.
 */
function devCors(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin
  if (origin && DEV_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Max-Age', '600')
      res.status(204).end()
      return
    }
  }
  next()
}

/**
 * The HTTP API. Routes answer both under `/sync` and at the root: Tailscale
 * Serve's `--set-path /sync` strips the prefix before proxying, while a
 * proxy target ending in `/sync` (or a dev setup without a proxy) keeps it.
 */
export function createApp({
  store,
  dev = false,
  logger,
}: {
  store: SeenStore
  dev?: boolean
  logger: Logger
}) {
  const app = express()
  app.disable('x-powered-by')
  app.set('query parser', 'simple')

  if (dev) app.use(devCors)
  app.use(compression())

  const routes = express.Router()

  routes.get('/health', (_req, res) => {
    if (store.isHealthy()) {
      res.json({status: 'ok'})
    } else {
      res.status(503).json({status: 'unavailable'})
    }
  })

  routes.post(
    '/seen',
    express.json({limit: MAX_BODY_BYTES, type: 'application/json'}),
    (req, res) => {
      if (!req.is('application/json')) {
        throw new InvalidRequestError('Content-Type must be application/json')
      }
      const {did, entries} = parseSeenBatch(req.body)
      const {serverTime} = store.write(did, entries)
      if (dev) {
        logger.info('stored', {did, entries: entries.length, serverTime})
      }
      res.json({serverTime})
    },
  )

  routes.get('/seen', (req, res) => {
    const {did, since, cursor} = parseChangesQuery(
      req.query as Record<string, unknown>,
    )
    const page = store.changes(did, {since, cursor})
    if (dev) {
      logger.info('changes', {
        did,
        since,
        entries: page.entries.length,
        more: page.cursor !== undefined,
      })
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json(page)
  })

  app.use(['/sync', '/'], routes)

  app.use((_req, res) => {
    res.status(404).json({error: 'NotFound', message: 'no such route'})
  })

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (
      err instanceof InvalidRequestError ||
      err instanceof InvalidPositionError
    ) {
      res.status(400).json({error: 'InvalidRequest', message: err.message})
      return
    }
    const type = (err as {type?: unknown})?.type
    if (type === 'entity.too.large') {
      res.status(413).json({
        error: 'PayloadTooLarge',
        message: `body must be at most ${MAX_BODY_BYTES} bytes`,
      })
      return
    }
    if (type === 'entity.parse.failed') {
      res
        .status(400)
        .json({error: 'InvalidRequest', message: 'body is not valid JSON'})
      return
    }
    const status = (err as {status?: unknown})?.status
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({
        error: 'InvalidRequest',
        message: err instanceof Error ? err.message : 'invalid request',
      })
      return
    }
    logger.error('request failed', {
      error: err instanceof Error ? err.stack : String(err),
    })
    res.status(500).json({error: 'InternalServerError'})
  }
  app.use(onError)

  return app
}
