import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOW = '.github/workflows/integration-test-asr-ggml.yml'
const STEP_SEPARATOR = '\n      - name: '
const UNIX_STEP = 'Run integration test (Unix)'
const WINDOWS_STEP = 'Run integration test (Windows)'
const BUDGET_PATTERN = /INTEGRATION_TEST_TIMEOUT: (.+)/

const src = readFileSync(join(root, WORKFLOW), 'utf8')

function findStep(name) {
  const step = src.split(STEP_SEPARATOR).find((candidate) => candidate.startsWith(`${name}\n`))
  assert.ok(step, `step not found: ${name}`)
  return step
}

function budgetOf(name) {
  const match = findStep(name).match(BUDGET_PATTERN)
  assert.ok(match, `${name} does not set INTEGRATION_TEST_TIMEOUT`)
  return match[1].trim()
}

test('the Unix integration step sets a literal parakeet suite budget', () => {
  assert.match(budgetOf(UNIX_STEP), /^'\d+'$/)
})

test('Unix and Windows give the parakeet suite the same budget', () => {
  assert.equal(budgetOf(UNIX_STEP), budgetOf(WINDOWS_STEP))
})
