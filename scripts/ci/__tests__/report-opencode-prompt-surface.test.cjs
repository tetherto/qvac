'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { inspectPromptSurface, maxTtftMs } = require('../report-opencode-prompt-surface.cjs')

// Real serve logs from OpenClaw runs; the format does not depend on the client.
const single = readFileSync(join(__dirname, 'fixtures/qvac-serve-openclaw-2026-9-3.stdout'), 'utf8')
const multi = readFileSync(join(__dirname, 'fixtures/qvac-serve-openclaw-2026-9-2.stdout'), 'utf8')

test('reads tools, prompt size and time to first token from a real run', () => {
  const result = inspectPromptSurface(single)
  assert.equal(result.requests, 1)
  assert.equal(result.maxTools, 12)
  assert.equal(result.promptTokens, 2499)
  assert.equal(result.ttftMs, 37049)
  assert.match(result.report, /\| Time to first token \(max observed\) \| 37049 ms \|/)
})

test('takes the worst request of a multi-request run', () => {
  const result = inspectPromptSurface(multi)
  assert.ok(result.requests > 1)
  assert.equal(result.maxTools, 36)
  assert.equal(result.promptTokens, 11781)
})

test('a missing serve log reads as unknown and says why', () => {
  const result = inspectPromptSurface(undefined)
  assert.match(result.report, /\| Chat requests \| unknown \|/)
  assert.match(result.report, /\| Advertised tools \(max observed\) \| unknown \|/)
  assert.match(result.report, /may predate the `serveBinPath` option/)
})

test('a request with no tool array reports none advertised, not unknown', () => {
  const log = '  chat model=qwen3.5-0.8b messages=2 stream=true\n'
  assert.match(inspectPromptSurface(log).report, /0 \(none advertised\)/)
})

test('maxTtftMs reads the millisecond-suffixed value', () => {
  assert.equal(maxTtftMs('ttft=12ms tps=3.0\nttft=340ms tps=1.0'), 340)
  assert.equal(maxTtftMs('tps=3.0'), undefined)
})
