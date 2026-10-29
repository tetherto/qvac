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
const formatted = fixture.replace('"text":"qvac-ok"', '"text":"**QVAC-OK!**"')
const serveLog = readFileSync(join(__dirname, 'fixtures/qvac-serve-openclaw-2026-9-3.stdout'), 'utf8')

// Fake `qvac` bin: prints a real serve log to stdout and a line to stderr.
function writeQvacStub (projectDir, logPath) {
  const binDir = join(projectDir, 'node_modules/.bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'qvac'), `#!/bin/sh
if [ "$1" = --version ]; then
  echo 0.0.0-test
  exit 0
fi
cat "${logPath}"
echo "serve stderr line" >&2
`, { mode: 0o755 })
}

// Exercise the real shell script and Node verifier, replacing only package
// installation and the OpenCode CLI. No model or network is needed.
for (const [name, output, exitCode, skip, expectedStatus] of [
  ['valid answer', fixture, 0, false, 0],
  ['formatted answer', formatted, 0, false, 0],
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
    const serveLogPath = join(root, 'serve.stdout')
    writeFileSync(serveLogPath, serveLog)
    writeQvacStub(join(root, 'project'), serveLogPath)
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(bin, 'npx'), `#!/bin/sh
if [ "$1" = opencode ] && [ "$2" = --version ]; then
  echo test-double
  exit 0
fi
if [ "$1" != opencode ] || [ "$2" != run ]; then exit 91; fi
for arg do prompt="$arg"; done
if [ "$prompt" != "Reply with only the word qvac-ok." ]; then exit 92; fi
# Start the serve through serveBinPath, as the plugin does.
serve_bin=$(node -p "require('./opencode.json').plugin[0][1].serveBinPath")
"$serve_bin" serve > /dev/null 2>&1 || exit 93
# tee is async; wait for it to flush.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  grep -q 'tools=12' "$ARTIFACT_DIR/qvac-serve.stdout" 2>/dev/null && break
  sleep 0.2
done
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

    // Captured on success and failure alike.
    assert.equal(existsSync(join(artifacts, 'prompt-surface.md')), !skip)
    if (!skip) {
      assert.equal(readFileSync(join(artifacts, 'qvac-serve.stdout'), 'utf8'), serveLog)
      assert.match(readFileSync(join(artifacts, 'qvac-serve.stderr'), 'utf8'), /serve stderr line/)
      const surface = readFileSync(join(artifacts, 'prompt-surface.md'), 'utf8')
      assert.match(surface, /Advertised tools \(max observed\) \| 12 \|/)
      assert.match(readFileSync(summaryPath, 'utf8'), /## Prompt surface/)
    }
  })
}

test('smoke fails before running OpenCode when the QVAC CLI is missing', { skip: process.platform === 'win32' }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'opencode-smoke-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 91\n', { mode: 0o755 })
  const result = spawnSync('bash', [smokeScript], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      PATH: bin + delimiter + process.env.PATH,
      SMOKE_DIR: join(root, 'project'),
      ARTIFACT_DIR: join(root, 'artifacts'),
      GITHUB_STEP_SUMMARY: '',
      QVAC_HOST_LOG: ''
    }
  })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /QVAC CLI not installed/)
})
