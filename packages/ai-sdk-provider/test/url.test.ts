import assert from 'node:assert/strict'
import test from 'node:test'

import { trimTrailingSlashes } from '../src/url.js'

test('trimTrailingSlashes removes every trailing slash and nothing else', () => {
  assert.equal(trimTrailingSlashes('http://127.0.0.1:55555/v1'), 'http://127.0.0.1:55555/v1')
  assert.equal(trimTrailingSlashes('http://127.0.0.1:55555/v1/'), 'http://127.0.0.1:55555/v1')
  assert.equal(trimTrailingSlashes('http://127.0.0.1:55555/v1///'), 'http://127.0.0.1:55555/v1')
  assert.equal(trimTrailingSlashes('http://host//v1//'), 'http://host//v1')
  assert.equal(trimTrailingSlashes('///'), '')
  assert.equal(trimTrailingSlashes(''), '')
})

test('trimTrailingSlashes stays linear on a long run of slashes before another character', () => {
  // `/\/+$/` takes seconds on this input because it retries from every slash.
  const url = `http://host${'/'.repeat(200_000)}v1`
  const started = performance.now()
  assert.equal(trimTrailingSlashes(url), url)
  assert.equal(trimTrailingSlashes(`${url}${'/'.repeat(200_000)}`), url)
  const elapsedMs = performance.now() - started
  assert.ok(elapsedMs < 1_000, `expected a linear scan, took ${elapsedMs.toFixed(1)}ms`)
})
