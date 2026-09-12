'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { delimiter, join, resolve } = require('node:path')

const smokeScript = resolve(__dirname, '../opencode-upstream-compat-smoke.sh')
const fixture = readFileSync(join(__dirname, 'fixtures/opencode-pass-qvac-ok.jsonl'), 'utf8')
const refusal = readFileSync(join(__dirname, 'fixtures/opencode-refusal-quoting-token.jsonl'), 'utf8')

// Exercise the real shell script and Node verifier, replacing only package
// installation and the OpenCode CLI. No model or network is needed.
for (const [name, output, exitCode, skip, expectedStatus] of [
  ['valid answer', fixture, 0, false, 0],
  ['empty output', '', 0, false, 1],
  ['refusal quoting the token', refusal, 0, false, 1],
  ['error event', '{"type":"error"}\n', 0, false, 1],
  ['malformed output', 'not json\n', 0, false, 1],
  ['incomplete run', fixture.trim().split('\n').slice(0, 2).join('\n'), 0, false, 1],
  ['CLI failure with valid output', fixture, 23, false, 23],
  ['explicitly skipped run', '', 0, true, 0]
]) {
  test(`smoke handles ${name}`, { skip: process.platform === 'win32' }, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'opencode-smoke-test-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const bin = join(root, 'bin')
    const artifacts = join(root, 'artifacts')
    const outputPath = join(root, 'output.jsonl')
    const summaryPath = join(root, 'summary.md')
    mkdirSync(bin)
    writeFileSync(outputPath, output)
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(bin, 'npx'), `#!/bin/sh
if [ "$1" = opencode ] && [ "$2" = --version ]; then
  echo test-double
  exit 0
fi
if [ "$1" != opencode ] || [ "$2" != run ]; then exit 91; fi
cat "$OPENCODE_TEST_OUTPUT"
exit "$OPENCODE_TEST_EXIT_CODE"
`, { mode: 0o755 })
    const result = spawnSync('bash', [smokeScript], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        SMOKE_DIR: join(root, 'project'),
        ARTIFACT_DIR: artifacts,
        GITHUB_STEP_SUMMARY: summaryPath,
        QVAC_HOST_LOG: '',
        SKIP_OPENCODE_RUN: skip ? '1' : '0',
        OPENCODE_TEST_OUTPUT: outputPath,
        OPENCODE_TEST_EXIT_CODE: String(exitCode)
      }
    })
    assert.ifError(result.error)
    assert.equal(result.status, expectedStatus, result.stderr)
    const success = expectedStatus === 0 && !skip
    assert.equal(existsSync(join(artifacts, 'smoke-result.md')), success)
    assert.equal(readFileSync(summaryPath, 'utf8').includes('completed successfully'), success)
    assert.equal(existsSync(join(artifacts, 'smoke-skipped.md')), skip)
    if (!skip) assert.equal(readFileSync(join(artifacts, 'opencode-run.jsonl'), 'utf8'), output)
  })
}
