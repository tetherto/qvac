import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  aggregateMetric,
  atomicWriteJson,
  buildMessages,
  computeMetrics,
  createFakeChunk,
  parseStream,
  rotateIds,
  validateRun,
  type StreamParseResult,
  type StreamTimings
} from './harness.ts'

describe('serve-openai-providers harness', () => {
  it('ignores role-only and reasoning-only chunks for first content', async () => {
    const timings: StreamTimings = {
      requestStartS: 100,
      firstContentS: null,
      lastContentS: null,
      streamEndS: null
    }
    const clock = [100.5, 100.8, 101.0]
    function now(): number {
      const next = clock.shift()
      assert.ok(next !== undefined)
      return next
    }
    const chunks = [
      createFakeChunk({ role: 'assistant', content: null }),
      createFakeChunk({ reasoningContent: 'thinking...' }),
      createFakeChunk({ content: 'Hello' }),
      createFakeChunk({ content: ' world' }),
      createFakeChunk({
        emptyChoices: true,
        usage: { promptTokens: 12, completionTokens: 4 },
        model: 'm'
      })
    ]
    const parsed = await parseStream(chunks, timings, now)
    assert.equal(parsed.content, 'Hello world')
    assert.equal(parsed.reasoningContent, 'thinking...')
    assert.equal(timings.firstContentS, 100.5)
    assert.equal(timings.lastContentS, 100.8)
    assert.equal(parsed.promptTokens, 12)
    assert.equal(parsed.completionTokens, 4)
  })

  it('requires and extracts final usage', async () => {
    const timings: StreamTimings = {
      requestStartS: 0,
      firstContentS: null,
      lastContentS: null,
      streamEndS: null
    }
    const chunks = [
      createFakeChunk({ content: 'x' }),
      createFakeChunk({
        emptyChoices: true,
        usage: { promptTokens: 100, completionTokens: 8 }
      })
    ]
    const parsed = await parseStream(chunks, timings, () => 1)
    const metrics = computeMetrics(parsed)
    const validation = validateRun({ parsed, metrics })
    assert.equal(validation.ok, true)
    assert.equal(metrics.promptTokens, 100)
    assert.equal(metrics.completionTokens, 8)
  })

  it('computes decode and effective prefill formulas', () => {
    const timings: StreamTimings = {
      requestStartS: 0,
      firstContentS: 0.5,
      lastContentS: 1.5,
      streamEndS: 1.6
    }
    const parsed: StreamParseResult = {
      content: 'abcd',
      reasoningContent: '',
      promptTokens: 200,
      completionTokens: 11,
      responseModel: 'm',
      timings,
      error: null
    }
    const metrics = computeMetrics(parsed)
    assert.equal(metrics.ttftMs, 500)
    assert.equal(metrics.totalMs, 1600)
    assert.equal(metrics.decodeWindowMs, 1000)
    assert.equal(metrics.decodeTps, 10)
    assert.equal(metrics.effectivePrefillTps, 400)
  })

  it('marks decode TPS unavailable for fewer than two completion tokens', () => {
    const timings: StreamTimings = {
      requestStartS: 0,
      firstContentS: 0.1,
      lastContentS: 0.2,
      streamEndS: 0.3
    }
    const parsed: StreamParseResult = {
      content: 'x',
      reasoningContent: '',
      promptTokens: 10,
      completionTokens: 1,
      responseModel: 'm',
      timings,
      error: null
    }
    const metrics = computeMetrics(parsed)
    assert.equal(metrics.decodeTps, null)
    assert.equal(metrics.decodeTpsUnavailableReason, 'completion_tokens_lt_2')
  })

  it('aggregates median quartiles and IQR for five values', () => {
    const stats = aggregateMetric([10, 20, 30, 40, 50], 0)
    assert.equal(stats.nValid, 5)
    assert.equal(stats.median, 30)
    assert.equal(stats.p25, 20)
    assert.equal(stats.p75, 40)
    assert.equal(stats.iqr, 20)
  })

  it('excludes failed/null values from aggregates', () => {
    const stats = aggregateMetric([10, null, 30], 1)
    assert.equal(stats.nValid, 2)
    assert.equal(stats.nFailed, 1)
    assert.equal(stats.median, 20)
  })

  it('persists results atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-'))
    try {
      const path = join(dir, 'raw.json')
      const payload: { runs: Array<{ id: number }> } = { runs: [{ id: 1 }] }
      atomicWriteJson(path, payload)
      payload.runs.push({ id: 2 })
      atomicWriteJson(path, payload)
      const loaded = JSON.parse(readFileSync(path, 'utf8')) as typeof payload
      assert.deepEqual(loaded.runs, [{ id: 1 }, { id: 2 }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails validation for missing usage and empty output', () => {
    const timings: StreamTimings = {
      requestStartS: 0,
      firstContentS: null,
      lastContentS: null,
      streamEndS: 1
    }
    const parsed: StreamParseResult = {
      content: '',
      reasoningContent: '',
      promptTokens: null,
      completionTokens: null,
      responseModel: 'm',
      timings,
      error: null
    }
    const metrics = computeMetrics(parsed)
    const validation = validateRun({ parsed, metrics })
    assert.equal(validation.ok, false)
    assert.ok(validation.reasons.includes('empty_content'))
    assert.ok(validation.reasons.includes('missing_usage'))
  })

  it('fails validation when think markers appear in content', () => {
    const timings: StreamTimings = {
      requestStartS: 0,
      firstContentS: 0.1,
      lastContentS: 0.2,
      streamEndS: 0.3
    }
    const parsed: StreamParseResult = {
      content: '<think>secret</think>answer',
      reasoningContent: '',
      promptTokens: 5,
      completionTokens: 5,
      responseModel: 'm',
      timings,
      error: null
    }
    const metrics = computeMetrics(parsed)
    const validation = validateRun({ parsed, metrics })
    assert.equal(validation.ok, false)
    assert.ok(validation.reasons.some((r) => r.startsWith('think_marker_in_content')))
  })

  it('fails validation when reasoning content is non-empty', () => {
    const timings: StreamTimings = {
      requestStartS: 0,
      firstContentS: 0.1,
      lastContentS: 0.2,
      streamEndS: 0.3
    }
    const parsed: StreamParseResult = {
      content: 'answer',
      reasoningContent: 'chain',
      promptTokens: 5,
      completionTokens: 5,
      responseModel: 'm',
      timings,
      error: null
    }
    const metrics = computeMetrics(parsed)
    const validation = validateRun({ parsed, metrics })
    assert.equal(validation.ok, false)
    assert.ok(validation.reasons.includes('reasoning_content_non_empty'))
  })

  it('rotates prompt ids', () => {
    assert.deepEqual(rotateIds(['a', 'b', 'c'], 1), ['b', 'c', 'a'])
  })

  it('inserts run ids into messages', () => {
    assert.deepEqual(buildMessages('hello', 'abc'), [{ role: 'user', content: '[run:abc] hello' }])
  })

  it('does not fail when response model differs from request model', () => {
    const timings: StreamTimings = {
      requestStartS: 0,
      firstContentS: 0.1,
      lastContentS: 0.2,
      streamEndS: 0.3
    }
    const parsed: StreamParseResult = {
      content: 'answer',
      reasoningContent: '',
      promptTokens: 5,
      completionTokens: 5,
      responseModel: 'some-other-visible-id',
      timings,
      error: null
    }
    const metrics = computeMetrics(parsed)
    const validation = validateRun({ parsed, metrics })
    assert.equal(validation.ok, true)
    assert.ok(!validation.reasons.some((r) => r.startsWith('model_mismatch')))
  })

  it('counts measured failures for fail-closed full', () => {
    const runs = [
      { phase: 'warmup', ok: false },
      { phase: 'measured', ok: true },
      { phase: 'measured', ok: false }
    ]
    const measuredFailures = runs.filter((r) => r.phase === 'measured' && !r.ok)
    assert.equal(measuredFailures.length, 1)
    assert.equal(measuredFailures.length > 0 ? 1 : 0, 1)
  })
})
