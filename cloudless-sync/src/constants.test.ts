import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {SEEN_LIST_LIMIT} from './constants.ts'

/**
 * The app's constants file imports nothing from the service and the service
 * builds without the app, so the app's value is read from its source.
 */
test('the seen-list limit matches the app', () => {
  const source = readFileSync(
    new URL('../../src/features/cloudless/seen/constants.ts', import.meta.url),
    'utf8',
  )
  const match = /export const SEEN_LIST_LIMIT = ([\d_]+)\b/.exec(source)
  assert.ok(match, 'SEEN_LIST_LIMIT not found in the app')
  assert.equal(Number(match[1].replaceAll('_', '')), SEEN_LIST_LIMIT)
})
