import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
// asr's test:integration runs the parakeet suite through this script on every platform.
const RUNNER = 'packages/asr-ggml/ci/integration.mjs'
const SUITE_CALL = "run('npm', ['run', 'test:integration'],"
const BUDGET_PATTERN = /INTEGRATION_TEST_TIMEOUT: (.+)/

const src = readFileSync(join(root, RUNNER), 'utf8')

function budget() {
  const start = src.indexOf(SUITE_CALL)
  assert.ok(start !== -1, `${RUNNER} does not run test:integration`)
  const call = src.slice(start, src.indexOf('})', start))
  const match = call.match(BUDGET_PATTERN)
  assert.ok(match, 'the test:integration run does not set INTEGRATION_TEST_TIMEOUT')
  return match[1].trim().replace(/,$/, '')
}

test('the test:integration run sets a literal parakeet suite budget', () => {
  assert.match(budget(), /^'\d+'$/)
})

test('Unix and Windows give the parakeet suite the same budget', () => {
  assert.doesNotMatch(budget(), /\bWIN\b|process\.platform|\?/)
})
