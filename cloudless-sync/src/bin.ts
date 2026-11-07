import {mkdirSync} from 'node:fs'
import {dirname} from 'node:path'

import {createApp, type Logger} from './app.ts'
import {readConfig} from './config.ts'
import {SeenStore} from './store.ts'

function log(level: 'info' | 'error') {
  return (message: string, data?: Record<string, unknown>) => {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...data,
    })
    if (level === 'error') console.error(line)
    else console.log(line)
  }
}

const logger: Logger = {info: log('info'), error: log('error')}
const config = readConfig()

mkdirSync(dirname(config.dbPath), {recursive: true})
const store = new SeenStore(config.dbPath)
const app = createApp({store, dev: config.dev, logger})

const server = app.listen(config.port, config.host, () => {
  logger.info('listening', {
    host: config.host,
    port: config.port,
    db: config.dbPath,
    dev: config.dev,
  })
})

let stopping = false
function stop(signal: string) {
  if (stopping) return
  stopping = true
  logger.info('stopping', {signal})
  server.close(() => {
    store.close()
    process.exit(0)
  })
  server.closeIdleConnections()
  // Give in-flight requests a moment, then close the database regardless.
  setTimeout(() => {
    store.close()
    process.exit(0)
  }, 5_000).unref()
}

process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
