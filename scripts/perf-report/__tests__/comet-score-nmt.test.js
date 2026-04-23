'use strict'

/**
 * Unit tests for scripts/perf-report/comet-score-nmt.js
 *
 * Exercises the pure-function code paths only — triple extraction,
 * dedup, markdown rendering, number formatting. No `gh`, no
 * `comet-score` CLI, no network. Runs under `node --test`.
 *
 * Run locally:
 *   node --test scripts/perf-report/__tests__/comet-score-nmt.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  collectReports,
  extractTriples,
  renderMarkdown,
  fmtPct,
  fmtComet,
  fmtDelta
} = require('../comet-score-nmt.js')

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeReport (deviceName, platform, results) {
  return {
    schema_version: '1.0',
    addon: 'nmtcpp',
    addon_type: 'translation',
    timestamp: '2026-04-23T12:00:00Z',
    device: { name: deviceName, platform, arch: 'arm64', runner: 'github' },
    results
  }
}

const SAMPLE_RESULT_OK = {
  test: '[Bergamot] [CPU]',
  execution_provider: 'cpu',
  metrics: { total_time_ms: 28, decode_time_ms: 28, generated_tokens: 7, tps: 249.62, chrfpp: 0.97 },
  input: 'Hello, how are you?',
  output: 'Ciao, come stai?',
  reference: 'Ciao, come stai?',
  quality: { chrfpp: 0.97, reference: 'Ciao, come stai?' }
}

// ---------------------------------------------------------------------------
// extractTriples
// ---------------------------------------------------------------------------

test('extractTriples: emits one triple per {device, test}', () => {
  const reports = [
    makeReport('iPhone 16 Pro', 'ios', [SAMPLE_RESULT_OK])
  ]
  const triples = extractTriples(reports)
  assert.equal(triples.length, 1)
  const t = triples[0]
  assert.equal(t.test, '[Bergamot] [CPU]')
  assert.equal(t.device, 'iPhone 16 Pro')
  assert.equal(t.platform, 'ios')
  assert.equal(t.src, 'Hello, how are you?')
  assert.equal(t.mt, 'Ciao, come stai?')
  assert.equal(t.ref, 'Ciao, come stai?')
  assert.equal(t.chrfpp, 0.97)
})

test('extractTriples: skips results missing input, output, or reference', () => {
  const reports = [
    makeReport('iPhone 16 Pro', 'ios', [
      { ...SAMPLE_RESULT_OK, input: '' },
      { ...SAMPLE_RESULT_OK, test: '[Bergamot] [GPU]', output: '' },
      { ...SAMPLE_RESULT_OK, test: '[IndicTrans] [CPU]', reference: '', quality: {} },
      { ...SAMPLE_RESULT_OK, test: '[Pivot es→en→it] [CPU]' }
    ])
  ]
  const triples = extractTriples(reports)
  assert.equal(triples.length, 1, 'only the fully-populated row should survive')
  assert.equal(triples[0].test, '[Pivot es→en→it] [CPU]')
})

test('extractTriples: dedup on {device, test} — last-seen wins', () => {
  const older = makeReport('iPhone 16 Pro', 'ios', [
    { ...SAMPLE_RESULT_OK, output: 'Outdated output' }
  ])
  const newer = makeReport('iPhone 16 Pro', 'ios', [
    { ...SAMPLE_RESULT_OK, output: 'Current output' }
  ])
  const triples = extractTriples([older, newer])
  assert.equal(triples.length, 1)
  assert.equal(triples[0].mt, 'Current output')
})

test('extractTriples: multiple devices stay distinct', () => {
  const reports = [
    makeReport('iPhone 16 Pro', 'ios', [SAMPLE_RESULT_OK]),
    makeReport('Google Pixel 9', 'android', [SAMPLE_RESULT_OK]),
    makeReport('Samsung Galaxy S25 Ultra', 'android', [SAMPLE_RESULT_OK])
  ]
  const triples = extractTriples(reports)
  assert.equal(triples.length, 3)
  const devices = triples.map(t => t.device).sort()
  assert.deepEqual(devices, ['Google Pixel 9', 'Samsung Galaxy S25 Ultra', 'iPhone 16 Pro'])
})

test('extractTriples: falls back to quality.reference when result.reference missing', () => {
  const result = { ...SAMPLE_RESULT_OK }
  delete result.reference
  const reports = [makeReport('iPhone 16 Pro', 'ios', [result])]
  const triples = extractTriples(reports)
  assert.equal(triples.length, 1)
  assert.equal(triples[0].ref, 'Ciao, come stai?')
})

test('extractTriples: chrfpp missing becomes null, not 0', () => {
  const result = { ...SAMPLE_RESULT_OK, metrics: { total_time_ms: 10 } }
  const reports = [makeReport('iPhone 16 Pro', 'ios', [result])]
  const triples = extractTriples(reports)
  assert.equal(triples[0].chrfpp, null)
})

// ---------------------------------------------------------------------------
// collectReports
// ---------------------------------------------------------------------------

test('collectReports: walks nested directories and returns valid reports only', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comet-test-'))
  try {
    // Valid nested report
    fs.mkdirSync(path.join(tmp, 'run-1', 'perf-report-nmtcpp-mobile-iOS'), { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'run-1', 'perf-report-nmtcpp-mobile-iOS', 'performance-report.json'),
      JSON.stringify(makeReport('iPhone 16 Pro', 'ios', [SAMPLE_RESULT_OK]))
    )
    // Another valid report at a different depth
    fs.mkdirSync(path.join(tmp, 'run-2'), { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'run-2', 'performance-report.json'),
      JSON.stringify(makeReport('Google Pixel 9', 'android', [SAMPLE_RESULT_OK]))
    )
    // Corrupt report — must be skipped, not crash
    fs.writeFileSync(path.join(tmp, 'run-2', 'performance-report.json.bak'), 'not-json')
    fs.mkdirSync(path.join(tmp, 'run-3'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'run-3', 'performance-report.json'), '{{{ broken')

    const reports = collectReports(tmp)
    assert.equal(reports.length, 2, 'two valid reports picked up, one corrupt one skipped')
    const devices = reports.map(r => r.device.name).sort()
    assert.deepEqual(devices, ['Google Pixel 9', 'iPhone 16 Pro'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// formatters
// ---------------------------------------------------------------------------

test('fmtPct: null → "-", number → percent with 1 decimal', () => {
  assert.equal(fmtPct(null), '-')
  assert.equal(fmtPct(undefined), '-')
  assert.equal(fmtPct(0.97), '97.0%')
  assert.equal(fmtPct(0.228), '22.8%')
  assert.equal(fmtPct(1), '100.0%')
})

test('fmtComet: null → "-", number → 3 decimals', () => {
  assert.equal(fmtComet(null), '-')
  assert.equal(fmtComet(0.832), '0.832')
  assert.equal(fmtComet(0.7104), '0.710')
})

test('fmtDelta: signed pp difference or "-" on missing', () => {
  assert.equal(fmtDelta(null, 0.97), '-')
  assert.equal(fmtDelta(0.85, null), '-')
  assert.equal(fmtDelta(0.85, 0.80), '+5.0pp')
  assert.equal(fmtDelta(0.55, 0.63), '-8.0pp')
  assert.equal(fmtDelta(0.80, 0.80), '+0.0pp')
})

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

test('renderMarkdown: empty triples → explains why and returns non-empty markdown', () => {
  const md = renderMarkdown([], null, {
    model: 'Unbabel/wmt22-comet-da',
    runs: 6,
    generatedAt: '2026-04-23T12:00:00Z'
  })
  assert.ok(md.includes('No scorable triples found'))
  assert.ok(md.includes('nmtcpp COMET Quality Report'))
})

test('renderMarkdown: with triples + scores renders a full table', () => {
  const triples = [
    { test: '[Bergamot] [CPU]', device: 'iPhone 16 Pro', platform: 'ios', src: 'Hi', mt: 'Ciao', ref: 'Ciao', chrfpp: 0.97 },
    { test: '[IndicTrans] [CPU]', device: 'iPhone 16 Pro', platform: 'ios', src: 'Hi', mt: 'Wrong', ref: 'Namaste', chrfpp: 0.228 }
  ]
  const scores = [0.88, 0.55]
  const md = renderMarkdown(triples, scores, {
    model: 'Unbabel/wmt22-comet-da',
    runs: 6,
    generatedAt: '2026-04-23T12:00:00Z'
  })
  assert.ok(md.includes('| Test | Device | chrF++ | COMET'))
  assert.ok(md.includes('[Bergamot] [CPU]'))
  assert.ok(md.includes('97.0%'))
  assert.ok(md.includes('0.880'))
  assert.ok(md.includes('22.8%'))
  assert.ok(md.includes('0.550'))
  assert.ok(md.includes('QVAC-16488'), 'explanation for mobile IndicTrans drop is surfaced')
})

test('renderMarkdown: COMET-skipped stub is still well-formed', () => {
  const triples = [
    { test: '[Bergamot] [CPU]', device: 'iPhone 16 Pro', platform: 'ios', src: 'Hi', mt: 'Ciao', ref: 'Ciao', chrfpp: 0.97 }
  ]
  const md = renderMarkdown(triples, null, {
    model: 'm',
    runs: 6,
    generatedAt: '2026-04-23T12:00:00Z',
    skipComet: true
  })
  assert.ok(md.includes('COMET scoring skipped'))
  assert.ok(md.includes('97.0%'))
  // COMET cell should render as "-" when no scores are provided
  const tableLine = md.split('\n').find(l => l.includes('[Bergamot] [CPU]'))
  assert.ok(tableLine.includes(' - '), 'missing COMET cell shows as "-"')
})

test('renderMarkdown: failure banner appears when scores are null but skip flag is false', () => {
  const triples = [
    { test: '[Bergamot] [CPU]', device: 'iPhone 16 Pro', platform: 'ios', src: 'Hi', mt: 'Ciao', ref: 'Ciao', chrfpp: 0.97 }
  ]
  const md = renderMarkdown(triples, null, {
    model: 'm',
    runs: 6,
    generatedAt: '2026-04-23T12:00:00Z'
  })
  assert.ok(md.includes('COMET scoring failed'))
})
