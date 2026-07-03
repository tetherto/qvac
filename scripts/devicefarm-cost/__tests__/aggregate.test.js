'use strict'

/**
 * Unit tests for the Device Farm cost report pure logic (QVAC-21758).
 * No AWS, no network — only the aggregation / windowing / rendering paths.
 *
 * Run locally:
 *   node --test scripts/devicefarm-cost/__tests__/
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  aggregate,
  filterRunsByWindow,
  deltaPct,
  fmtDelta,
  dayKeyUTC,
  renderMarkdown
} = require('../aggregate')

const { parseArgs, parseDay, computeWindows, makeProjectFilter } = require('../report')

const D1 = Date.parse('2026-06-01T10:00:00.000Z')
const D2 = Date.parse('2026-06-02T10:00:00.000Z')

function sampleRuns () {
  return [
    { project: 'qvac-lib-infer-llamacpp-llm', arn: 'a1', name: 'r1', created: D1, platform: 'ANDROID', result: 'PASSED', meteredMinutes: 100 },
    { project: 'qvac-lib-infer-llamacpp-llm', arn: 'a2', name: 'r2', created: D2, platform: 'IOS', result: 'PASSED', meteredMinutes: 50 },
    { project: 'qvac-lib-infer-onnx-tts', arn: 'b1', name: 'r3', created: D1, platform: 'ANDROID', result: 'FAILED', meteredMinutes: 25 }
  ]
}

test('aggregate totals, cost, and per-project share/sort', () => {
  const agg = aggregate(sampleRuns(), { rate: 0.17 })
  assert.equal(agg.runCount, 3)
  assert.equal(agg.meteredMinutes, 175)
  assert.equal(agg.cost, 29.75)

  assert.equal(agg.perProject.length, 2)
  // Sorted by metered minutes desc: LLM first.
  assert.equal(agg.perProject[0].project, 'qvac-lib-infer-llamacpp-llm')
  assert.equal(agg.perProject[0].meteredMinutes, 150)
  assert.equal(agg.perProject[0].cost, 25.5)
  assert.equal(agg.perProject[0].sharePct, 85.71)
  assert.equal(agg.perProject[1].sharePct, 14.29)
})

test('aggregate groups per UTC day', () => {
  const agg = aggregate(sampleRuns(), { rate: 0.17 })
  assert.deepEqual(
    agg.perDay.map((d) => [d.date, d.meteredMinutes, d.runCount]),
    [
      ['2026-06-01', 125, 2],
      ['2026-06-02', 50, 1]
    ]
  )
})

test('aggregate handles empty input', () => {
  const agg = aggregate([], { rate: 0.17 })
  assert.equal(agg.runCount, 0)
  assert.equal(agg.meteredMinutes, 0)
  assert.equal(agg.cost, 0)
  assert.deepEqual(agg.perProject, [])
  assert.deepEqual(agg.perDay, [])
})

test('filterRunsByWindow is [start, end) half-open', () => {
  const start = Date.parse('2026-06-01T00:00:00.000Z')
  const end = Date.parse('2026-06-02T00:00:00.000Z')
  const kept = filterRunsByWindow(sampleRuns(), start, end)
  assert.equal(kept.length, 2) // both day-1 runs, not the day-2 one
  assert.ok(kept.every((r) => r.created >= start && r.created < end))

  // Boundary: a run exactly at `end` is excluded.
  const atEnd = [{ project: 'p', created: end, meteredMinutes: 1 }]
  assert.equal(filterRunsByWindow(atEnd, start, end).length, 0)
})

test('deltaPct / fmtDelta', () => {
  assert.equal(deltaPct(150, 100), 50)
  assert.equal(deltaPct(50, 100), -50)
  assert.equal(deltaPct(10, 0), null)
  assert.equal(fmtDelta(150, 100), '+50%')
  assert.equal(fmtDelta(50, 100), '-50%')
  assert.equal(fmtDelta(10, 0), 'new')
  assert.equal(fmtDelta(0, 0), '—')
})

test('dayKeyUTC', () => {
  assert.equal(dayKeyUTC(D1), '2026-06-01')
})

test('renderMarkdown includes sections, projects, and WoW row', () => {
  const runs = sampleRuns()
  const current = aggregate(runs, { rate: 0.17 })
  const previous = aggregate([{ project: 'qvac-lib-infer-llamacpp-llm', created: D1, meteredMinutes: 300 }], { rate: 0.17 })
  const md = renderMarkdown({
    current,
    previous,
    currentWindow: { startMs: Date.parse('2026-06-01T00:00:00Z'), endMs: Date.parse('2026-06-08T00:00:00Z') },
    previousWindow: { startMs: Date.parse('2026-05-25T00:00:00Z'), endMs: Date.parse('2026-06-01T00:00:00Z') },
    rate: 0.17,
    generatedAt: Date.parse('2026-06-08T09:00:00Z'),
    errors: []
  })
  assert.match(md, /AWS Device Farm — Cost Report/)
  assert.match(md, /By project/)
  assert.match(md, /By day \(UTC\)/)
  assert.match(md, /qvac-lib-infer-llamacpp-llm/)
  assert.match(md, /qvac-lib-infer-onnx-tts/)
  // 150 metered vs 300 baseline for the LLM project → -50% somewhere.
  assert.match(md, /-50%/)
})

test('renderMarkdown surfaces partial-data errors', () => {
  const md = renderMarkdown({
    current: aggregate([], { rate: 0.17 }),
    currentWindow: { startMs: Date.parse('2026-06-01T00:00:00Z'), endMs: Date.parse('2026-06-08T00:00:00Z') },
    rate: 0.17,
    errors: ['some-project: aws exited 255: AccessDenied']
  })
  assert.match(md, /Partial data/)
  assert.match(md, /AccessDenied/)
})

test('parseArgs reads flags and repeatable --project', () => {
  const opts = parseArgs(['--days', '14', '--rate', '0.2', '--no-compare', '--project', 'llm', '--project', 'tts', '--json', 'out.json', '--summary'])
  assert.equal(opts.days, 14)
  assert.equal(opts.rate, 0.2)
  assert.equal(opts.compare, false)
  assert.deepEqual(opts.projects, ['llm', 'tts'])
  assert.equal(opts.json, 'out.json')
  assert.equal(opts.summary, true)
})

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/)
})

test('parseDay parses UTC midnight and rejects garbage', () => {
  assert.equal(parseDay('2026-06-01', 'since'), Date.parse('2026-06-01T00:00:00.000Z'))
  assert.throws(() => parseDay('nope', 'since'), /Invalid since date/)
})

test('computeWindows: default rolling 7-day window + previous baseline', () => {
  const now = Date.parse('2026-06-08T00:00:00.000Z')
  const { current, previous } = computeWindows({ days: 7, compare: true }, now)
  assert.equal(current.endMs, now)
  assert.equal(current.startMs, Date.parse('2026-06-01T00:00:00.000Z'))
  assert.equal(previous.startMs, Date.parse('2026-05-25T00:00:00.000Z'))
  assert.equal(previous.endMs, current.startMs)
})

test('computeWindows: explicit since/until, no compare', () => {
  const { current, previous } = computeWindows(
    { since: '2026-06-01', until: '2026-07-01', compare: false },
    Date.parse('2026-07-03T00:00:00Z')
  )
  assert.equal(current.startMs, Date.parse('2026-06-01T00:00:00Z'))
  assert.equal(current.endMs, Date.parse('2026-07-01T00:00:00Z'))
  assert.equal(previous, null)
})

test('computeWindows rejects inverted window', () => {
  assert.throws(
    () => computeWindows({ since: '2026-07-01', until: '2026-06-01', compare: false }, Date.now()),
    /start must be before/
  )
})

test('makeProjectFilter matches case-insensitive substrings', () => {
  const f = makeProjectFilter(['LLM', 'tts'])
  assert.equal(f('qvac-lib-infer-llamacpp-llm'), true)
  assert.equal(f('qvac-lib-infer-onnx-TTS'), true)
  assert.equal(f('qvac-lib-infer-parakeet'), false)
  assert.equal(makeProjectFilter([]), null)
})
