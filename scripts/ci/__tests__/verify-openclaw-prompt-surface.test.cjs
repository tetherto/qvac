'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { inspectPromptSurface, maxMetric } = require('../verify-openclaw-prompt-surface.cjs')

// Both fixtures are unmodified `qvac serve` request lines from real scheduled
// runs, trimmed to the lines this verifier reads.
//
// 2026-09-02 (run 34200142844, openclaw 2026.9.2): 36 advertised tools, prompt
// up to 11781 tokens, ttft ~175-195s per turn, finish=tool_calls throughout.
// Failed after three attempts.
//
// 2026-09-09 (run 34324684069, openclaw 2026.9.3): 12 advertised tools, prompt
// 2499 tokens, ttft 37s, finish=stop. Passed on the first attempt.
//
// Nothing changed on the QVAC side between them, which is the case for pinning
// the surface rather than trusting whatever upstream advertises.
const unbounded = readFileSync(join(__dirname, 'fixtures/qvac-serve-openclaw-2026-9-2.stdout'), 'utf8')
const bounded = readFileSync(join(__dirname, 'fixtures/qvac-serve-openclaw-2026-9-3.stdout'), 'utf8')

test('reads the worst tool count and prompt size from a real run', () => {
  const result = inspectPromptSurface(unbounded, 'coding', 8)
  assert.equal(result.maxTools, 36)
  assert.equal(result.promptTokens, 11781)
})

test('fails the run that could not pass, naming the count and the ceiling', () => {
  const result = inspectPromptSurface(unbounded, 'coding', 8)
  assert.equal(result.ok, false)
  assert.match(result.reason, /36 tools/)
  assert.match(result.reason, /tools\.profile=coding/)
  assert.match(result.reason, /8 ceiling/)
})

test('accepts a surface inside the ceiling', () => {
  const result = inspectPromptSurface(bounded, 'minimal', 12)
  assert.equal(result.ok, true)
  assert.equal(result.maxTools, 12)
  assert.equal(result.promptTokens, 2499)
  assert.equal(result.reason, undefined)
})

test('the same upstream run fails one ceiling and passes another', () => {
  assert.equal(inspectPromptSurface(bounded, 'minimal', 8).ok, false)
  assert.equal(inspectPromptSurface(bounded, 'minimal', 12).ok, true)
})

test('a count exactly at the ceiling passes', () => {
  const result = inspectPromptSurface('chat model=m stream=true tools=8', 'minimal', 8)
  assert.equal(result.ok, true)
})

// An absent measurement is not a bounded surface. Reporting 0 here would claim
// a ceiling was respected when nothing was ever measured -- the same shape of
// false green that #4128 removed from the agent verifier.
test('an unmeasured surface is reported as unknown, not as zero', () => {
  const result = inspectPromptSurface('', 'minimal', 8)
  assert.equal(result.ok, true)
  assert.equal(result.maxTools, undefined)
  assert.equal(result.promptTokens, undefined)
  assert.match(result.report, /Advertised tools \(max observed\) \| unknown/)
  assert.doesNotMatch(result.report, /max observed\) \| 0 /)
})

test('a serve log with no chat request is unmeasured', () => {
  const result = inspectPromptSurface('← 200 GET /v1/models (3ms)\n', 'minimal', 8)
  assert.equal(result.maxTools, undefined)
})

test('the report carries the profile, both measures and the ceiling', () => {
  const report = inspectPromptSurface(bounded, 'minimal', 8).report
  assert.match(report, /## Prompt surface/)
  assert.match(report, /`tools\.profile` \| `minimal`/)
  assert.match(report, /Advertised tools \(max observed\) \| 12/)
  assert.match(report, /Prompt tokens \(max observed\) \| 2499/)
  assert.match(report, /Tool ceiling \| 8/)
})

// `tools=12` must not be read out of `genParams={"predict":8192}` or out of a
// longer token like `maxtools=99`.
test('matches whole metric names only', () => {
  assert.equal(maxMetric('maxtools=99 tools=3', 'tools'), 3)
  assert.equal(maxMetric('prompt_tokens=50 prompt=7', 'prompt'), 7)
})

test('takes the maximum across requests, not the first or last', () => {
  assert.equal(maxMetric('tools=4\ntools=31\ntools=9', 'tools'), 31)
})

// The smoke script branches on this exit code and uploads the report file, so
// both are part of the contract, not implementation detail.
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')

function runCli (t, logFixture, ceiling) {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-surface-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = join(dir, 'prompt-surface.md')
  const result = spawnSync(process.execPath, [
    join(__dirname, '../verify-openclaw-prompt-surface.cjs'),
    join(__dirname, 'fixtures', logFixture),
    'minimal',
    String(ceiling),
    out
  ], { encoding: 'utf8' })
  return { result, out }
}

test('the CLI exits 1 and still writes the report when the surface drifted', (t) => {
  const { result, out } = runCli(t, 'qvac-serve-openclaw-2026-9-2.stdout', 8)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /36 tools/)
  assert.match(readFileSync(out, 'utf8'), /Advertised tools \(max observed\) \| 36/)
})

test('the CLI exits 0 and writes the report when the surface is bounded', (t) => {
  const { result, out } = runCli(t, 'qvac-serve-openclaw-2026-9-3.stdout', 12)
  assert.equal(result.status, 0)
  assert.match(readFileSync(out, 'utf8'), /Advertised tools \(max observed\) \| 12/)
})

// A serve log is diagnostic. Losing it must not fail the smoke -- the agent
// verdict is the signal.
test('a missing serve log warns and still writes an unknown report', (t) => {
  const { result, out } = runCli(t, 'does-not-exist.stdout', 8)
  assert.equal(result.status, 0)
  assert.match(result.stderr, /no serve log/)
  assert.ok(existsSync(out))
  assert.match(readFileSync(out, 'utf8'), /unknown/)
})

for (const ceiling of ['0', 'eight', '-3']) {
  test(`the CLI refuses an invalid ceiling ${JSON.stringify(ceiling)}`, (t) => {
    const { result } = runCli(t, 'qvac-serve-openclaw-2026-9-3.stdout', ceiling)
    assert.equal(result.status, 2)
  })
}
