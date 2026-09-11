'use strict'

/**
 * Drift guard for the rtf_expected_devices workflow outputs.
 *
 * Each speech integration workflow exposes an expected-device list built as a
 * positional format() over runner_names outputs, and the list must stay in
 * lockstep with the matrix `include` rows in the same file. The dangerous
 * drift direction is silent: a new matrix row that is not appended to the
 * list is simply unguarded — its artifact can vanish from the consolidated
 * report exactly like the bug the gate exists to close. This test makes that
 * drift fail loudly by asserting, per workflow:
 *
 *   format() placeholder count == format() argument count == matrix row count
 *
 * The matrix row count is taken from the `- os:` entries at the include
 * list's fixed indentation. If the workflow formatting changes, this test
 * fails loudly and should be updated together with the matrix — loud beats
 * silent here.
 *
 * Run locally:
 *   node --test scripts/perf-report/__tests__/rtf-expected-devices-guard.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const WORKFLOWS_DIR = path.join(__dirname, '..', '..', '..', '.github', 'workflows')

const GUARDED_WORKFLOWS = [
  'integration-test-asr-ggml.yml',
  'integration-test-tts-ggml.yml',
  'integration-test-bci-whispercpp.yml'
]

const MATRIX_ROW_RE = /^ {10}- os: /gm
const OUTPUT_VALUE_RE = /rtf_expected_devices:[\s\S]*?value: \$\{\{ format\('([^']*)',([\s\S]*?)\) \}\}/

function countMatches (text, re) {
  const matches = text.match(re)
  return matches ? matches.length : 0
}

for (const workflow of GUARDED_WORKFLOWS) {
  test(`${workflow}: rtf_expected_devices stays in lockstep with the benchmark matrix`, () => {
    const source = fs.readFileSync(path.join(WORKFLOWS_DIR, workflow), 'utf8')

    const output = source.match(OUTPUT_VALUE_RE)
    assert.ok(output, 'rtf_expected_devices output with a format() value must exist')

    const placeholderCount = countMatches(output[1], /\{\d+\}/g)
    const argumentCount = countMatches(output[2], /jobs\.runner_names\.outputs\.[a-z0-9_]+/g)
    const matrixRowCount = countMatches(source, MATRIX_ROW_RE)

    assert.ok(matrixRowCount > 0, 'the benchmark matrix include rows must be detectable')
    assert.equal(
      argumentCount,
      placeholderCount,
      `format() lists ${argumentCount} runner_names output(s) for ${placeholderCount} placeholder(s)`
    )
    assert.equal(
      placeholderCount,
      matrixRowCount,
      `rtf_expected_devices names ${placeholderCount} device(s) but the matrix has ${matrixRowCount} row(s) — ` +
      'a row missing from the list is unguarded against silent artifact loss; append its runner_names output to the format() call'
    )
  })
}
