'use strict'

/**
 * Unit tests for scripts/perf-report/comet-score-nmt.js
 *
 * Exercises the pure-function code paths only — canonical device
 * labelling, triple extraction, aggregation (mean/std), formatters,
 * markdown rendering. No `gh`, no `comet-score` CLI, no network.
 *
 * Run locally:
 *   node --test scripts/perf-report/__tests__/comet-score-nmt.test.js
 */

// `node:test` and `node:assert/strict` require the `node:` prefix;
// fs/os/path are referenced in the bare form to match the style of
// every other script in scripts/perf-report.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  parseArgs,
  canonicalDeviceLabel,
  collectReportsFromDir,
  extractTriples,
  aggregateGroups,
  renderMarkdown,
  fmtPct,
  fmtComet,
  fmtPctMeanStd,
  fmtCometMeanStd,
  fmtTpsMeanStd
} = require('../comet-score-nmt.js')

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeReport (deviceName, platform, results, arch = 'arm64') {
  return {
    schema_version: '1.0',
    addon: 'nmtcpp',
    addon_type: 'translation',
    timestamp: '2026-04-23T12:00:00Z',
    device: { name: deviceName, platform, arch, runner: 'github' },
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
// canonicalDeviceLabel
// ---------------------------------------------------------------------------

test('canonicalDeviceLabel: collapses ephemeral GitHub-hosted runner ids', () => {
  assert.equal(canonicalDeviceLabel('GitHub Actions 1000320663', 'linux', 'x64'), 'linux/x64 (hosted)')
  assert.equal(canonicalDeviceLabel('GitHub Actions 1', 'darwin', 'arm64'), 'darwin/arm64 (hosted)')
  assert.equal(canonicalDeviceLabel('GitHub Actions 1000320797', 'linux', 'arm64'), 'linux/arm64 (hosted)')
})

test('canonicalDeviceLabel: strips trailing 6+ digit suffix from self-hosted runners', () => {
  assert.equal(canonicalDeviceLabel('ai-run-windows11-gpu-1000320651', 'win32', 'x64'), 'ai-run-windows11-gpu')
  assert.equal(canonicalDeviceLabel('ai-run-macos14-arm-1000320800', 'darwin', 'arm64'), 'ai-run-macos14-arm')
})

test('canonicalDeviceLabel: leaves stable Device Farm device names unchanged', () => {
  assert.equal(canonicalDeviceLabel('Apple iPhone 16 Pro', 'ios', 'arm64'), 'Apple iPhone 16 Pro')
  assert.equal(canonicalDeviceLabel('Google Pixel 9', 'android', 'arm64'), 'Google Pixel 9')
  assert.equal(canonicalDeviceLabel('Samsung Galaxy S25 Ultra', 'android', 'arm64'), 'Samsung Galaxy S25 Ultra')
})

test('canonicalDeviceLabel: handles empty or missing name', () => {
  assert.equal(canonicalDeviceLabel('', 'linux', 'x64'), 'linux/x64 (hosted)')
  assert.equal(canonicalDeviceLabel(null, 'linux', 'x64'), 'linux/x64 (hosted)')
  assert.equal(canonicalDeviceLabel(undefined, 'linux', 'x64'), 'linux/x64 (hosted)')
})

// ---------------------------------------------------------------------------
// extractTriples
// ---------------------------------------------------------------------------

test('extractTriples: emits one triple per result and attaches canonicalDevice', () => {
  const reports = [
    makeReport('iPhone 16 Pro', 'ios', [SAMPLE_RESULT_OK])
  ]
  const triples = extractTriples(reports)
  assert.equal(triples.length, 1)
  const t = triples[0]
  assert.equal(t.test, '[Bergamot] [CPU]')
  assert.equal(t.device, 'iPhone 16 Pro')
  assert.equal(t.canonicalDevice, 'iPhone 16 Pro')
  assert.equal(t.platform, 'ios')
  assert.equal(t.arch, 'arm64')
  assert.equal(t.src, 'Hello, how are you?')
  assert.equal(t.mt, 'Ciao, come stai?')
  assert.equal(t.ref, 'Ciao, come stai?')
  assert.equal(t.chrfpp, 0.97)
  assert.equal(t.tps, 249.62)
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

test('extractTriples: retains duplicates across runs (dedup happens in aggregation)', () => {
  const older = makeReport('GitHub Actions 1', 'linux', [
    { ...SAMPLE_RESULT_OK, output: 'Outdated output', metrics: { chrfpp: 0.80 } }
  ], 'x64')
  const newer = makeReport('GitHub Actions 2', 'linux', [
    { ...SAMPLE_RESULT_OK, output: 'Current output', metrics: { chrfpp: 0.95 } }
  ], 'x64')
  const triples = extractTriples([older, newer])
  assert.equal(triples.length, 2, 'both runs should produce triples at extraction time')
  // Both should canonicalise to the same stable label
  assert.equal(triples[0].canonicalDevice, 'linux/x64 (hosted)')
  assert.equal(triples[1].canonicalDevice, 'linux/x64 (hosted)')
})

test('extractTriples: multiple devices stay distinct', () => {
  const reports = [
    makeReport('iPhone 16 Pro', 'ios', [SAMPLE_RESULT_OK]),
    makeReport('Google Pixel 9', 'android', [SAMPLE_RESULT_OK]),
    makeReport('Samsung Galaxy S25 Ultra', 'android', [SAMPLE_RESULT_OK])
  ]
  const triples = extractTriples(reports)
  assert.equal(triples.length, 3)
  const devices = triples.map(t => t.canonicalDevice).sort()
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

test('extractTriples: tps missing becomes null (legacy reports without TPS)', () => {
  const result = { ...SAMPLE_RESULT_OK, metrics: { chrfpp: 0.97 } }
  const reports = [makeReport('iPhone 16 Pro', 'ios', [result])]
  const triples = extractTriples(reports)
  assert.equal(triples[0].chrfpp, 0.97)
  assert.equal(triples[0].tps, null)
})

// ---------------------------------------------------------------------------
// aggregateGroups
// ---------------------------------------------------------------------------

test('aggregateGroups: single-device single-run → one group with std=0', () => {
  const triples = [
    { test: '[Bergamot] [CPU]', canonicalDevice: 'linux/x64 (hosted)', platform: 'linux', arch: 'x64', chrfpp: 0.97, tps: 249.62 }
  ]
  const groups = aggregateGroups(triples, [0.983])
  assert.equal(groups.length, 1)
  const g = groups[0]
  assert.equal(g.runs, 1)
  assert.equal(g.chrfppMean, 0.97)
  assert.equal(g.chrfppStd, 0)
  assert.equal(g.cometMean, 0.983)
  assert.equal(g.cometStd, 0)
  assert.equal(g.tpsMean, 249.62)
  assert.equal(g.tpsStd, 0)
  assert.equal(g.tpsCount, 1)
})

test('aggregateGroups: TPS mean and std reflect run-to-run perf drift', () => {
  // Same cell, 3 runs, TPS wandered between 70 and 90 tokens/sec.
  const triples = [
    { test: '[Bergamot] [CPU]', canonicalDevice: 'linux/x64 (hosted)', platform: 'linux', arch: 'x64', chrfpp: 0.97, tps: 70 },
    { test: '[Bergamot] [CPU]', canonicalDevice: 'linux/x64 (hosted)', platform: 'linux', arch: 'x64', chrfpp: 0.97, tps: 80 },
    { test: '[Bergamot] [CPU]', canonicalDevice: 'linux/x64 (hosted)', platform: 'linux', arch: 'x64', chrfpp: 0.97, tps: 90 }
  ]
  const groups = aggregateGroups(triples, [0.983, 0.983, 0.983])
  assert.equal(groups.length, 1)
  const g = groups[0]
  assert.equal(g.tpsCount, 3)
  assert.ok(Math.abs(g.tpsMean - 80) < 1e-10, 'mean of 70/80/90 is 80')
  // Sample std of [70, 80, 90] (n-1 denominator) = sqrt(200/2) = 10.
  // We use sample std intentionally — same formula as utils.stddev,
  // so this report's "std = X" matches what the aggregate.js report
  // writes for the same underlying values.
  assert.ok(Math.abs(g.tpsStd - 10) < 1e-10)
})

test('aggregateGroups: TPS gracefully null when missing from all triples', () => {
  const triples = [
    { test: '[Bergamot] [CPU]', canonicalDevice: 'linux/x64 (hosted)', platform: 'linux', arch: 'x64', chrfpp: 0.97, tps: null },
    { test: '[Bergamot] [CPU]', canonicalDevice: 'linux/x64 (hosted)', platform: 'linux', arch: 'x64', chrfpp: 0.97 }
  ]
  const groups = aggregateGroups(triples, [0.983, 0.983])
  assert.equal(groups[0].tpsCount, 0)
  assert.equal(groups[0].tpsMean, null)
  assert.equal(groups[0].tpsStd, 0)
})

test('aggregateGroups: collapses multiple identical runs into one group', () => {
  // 6 runs of the same matrix cell landed on 6 different ephemeral VMs
  const triples = Array(6).fill(null).map(() => ({
    test: '[Bergamot] [CPU]',
    canonicalDevice: 'linux/x64 (hosted)',
    platform: 'linux',
    arch: 'x64',
    chrfpp: 0.97
  }))
  const scores = Array(6).fill(0.983)
  const groups = aggregateGroups(triples, scores)
  assert.equal(groups.length, 1, 'six dupes → one group')
  assert.equal(groups[0].runs, 6)
  // Mean / std of 6× identical values are nominally the value / 0, but
  // floating-point sum/divide/sqrt lands ~1e-16 off — assert within tolerance.
  assert.ok(Math.abs(groups[0].chrfppMean - 0.97) < 1e-10)
  assert.ok(groups[0].chrfppStd < 1e-10, 'deterministic metric → std ≈ 0')
  assert.ok(Math.abs(groups[0].cometMean - 0.983) < 1e-10)
  assert.ok(groups[0].cometStd < 1e-10)
})

test('aggregateGroups: non-zero std when values drift between runs', () => {
  const triples = [
    { test: '[Bergamot] [CPU]', canonicalDevice: 'linux/x64 (hosted)', platform: 'linux', arch: 'x64', chrfpp: 0.90 },
    { test: '[Bergamot] [CPU]', canonicalDevice: 'linux/x64 (hosted)', platform: 'linux', arch: 'x64', chrfpp: 1.00 }
  ]
  const groups = aggregateGroups(triples, [0.85, 0.95])
  assert.equal(groups.length, 1)
  const g = groups[0]
  assert.equal(g.runs, 2)
  assert.equal(Math.round(g.chrfppMean * 100) / 100, 0.95)
  // Sample std (n-1 denominator) over [0.90, 1.00] = sqrt(0.005/1) ≈ 0.0707.
  // Matches utils.stddev so aggregate.js and this report agree.
  assert.ok(Math.abs(g.chrfppStd - Math.sqrt(0.005)) < 1e-10)
  assert.equal(Math.round(g.cometMean * 100) / 100, 0.90)
  assert.ok(Math.abs(g.cometStd - Math.sqrt(0.005)) < 1e-10)
})

test('aggregateGroups: cpu and gpu stay on separate rows (different test labels)', () => {
  const triples = [
    { test: '[Bergamot] [CPU]', canonicalDevice: 'iPhone 16 Pro', platform: 'ios', arch: 'arm64', chrfpp: 1.00 },
    { test: '[Bergamot] [GPU]', canonicalDevice: 'iPhone 16 Pro', platform: 'ios', arch: 'arm64', chrfpp: 1.00 }
  ]
  const groups = aggregateGroups(triples, [0.995, 0.995])
  assert.equal(groups.length, 2)
  const labels = groups.map(g => g.test).sort()
  assert.deepEqual(labels, ['[Bergamot] [CPU]', '[Bergamot] [GPU]'])
})

test('aggregateGroups: nulls in comet scores don\'t pollute the mean', () => {
  const triples = [
    { test: '[Bergamot] [CPU]', canonicalDevice: 'linux/x64 (hosted)', platform: 'linux', arch: 'x64', chrfpp: 0.97 },
    { test: '[Bergamot] [CPU]', canonicalDevice: 'linux/x64 (hosted)', platform: 'linux', arch: 'x64', chrfpp: 0.97 }
  ]
  const groups = aggregateGroups(triples, [0.983, null])
  assert.equal(groups[0].runs, 2)
  assert.equal(groups[0].cometCount, 1, 'only one valid score contributed to COMET mean')
  assert.equal(groups[0].cometMean, 0.983)
})

test('aggregateGroups: null cometScores (skip/failure path) → cometMean null', () => {
  const triples = [
    { test: '[Bergamot] [CPU]', canonicalDevice: 'iPhone 16 Pro', platform: 'ios', arch: 'arm64', chrfpp: 0.97 }
  ]
  const groups = aggregateGroups(triples, null)
  assert.equal(groups[0].cometMean, null)
  assert.equal(groups[0].cometCount, 0)
})

// ---------------------------------------------------------------------------
// collectReportsFromDir
// ---------------------------------------------------------------------------

test('collectReportsFromDir: walks nested directories and returns valid reports only', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comet-test-'))
  try {
    fs.mkdirSync(path.join(tmp, 'run-1', 'perf-report-nmtcpp-mobile-iOS'), { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'run-1', 'perf-report-nmtcpp-mobile-iOS', 'performance-report.json'),
      JSON.stringify(makeReport('iPhone 16 Pro', 'ios', [SAMPLE_RESULT_OK]))
    )
    fs.mkdirSync(path.join(tmp, 'run-2'), { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'run-2', 'performance-report.json'),
      JSON.stringify(makeReport('Google Pixel 9', 'android', [SAMPLE_RESULT_OK]))
    )
    fs.writeFileSync(path.join(tmp, 'run-2', 'performance-report.json.bak'), 'not-json')
    fs.mkdirSync(path.join(tmp, 'run-3'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'run-3', 'performance-report.json'), '{{{ broken')

    const reports = collectReportsFromDir(tmp)
    assert.equal(reports.length, 2)
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

test('fmtPctMeanStd: renders mean ±std as pp or "-"', () => {
  assert.equal(fmtPctMeanStd(null, 0), '-')
  assert.equal(fmtPctMeanStd(0.97, 0), '97.0% ±0.0%')
  assert.equal(fmtPctMeanStd(0.97, 0.05), '97.0% ±5.0%')
})

test('fmtCometMeanStd: renders mean ±std in raw 0-1 units or "-"', () => {
  assert.equal(fmtCometMeanStd(null, 0), '-')
  assert.equal(fmtCometMeanStd(0.983, 0), '0.983 ±0.000')
  assert.equal(fmtCometMeanStd(0.95, 0.05), '0.950 ±0.050')
})

test('fmtTpsMeanStd: renders mean ±std in t/s, auto-adjusting precision', () => {
  assert.equal(fmtTpsMeanStd(null, 0), '-')
  // Below 100 t/s (mobile / desktop CPU regime): keep 1 decimal so "22.8" and "80.0" remain distinguishable.
  assert.equal(fmtTpsMeanStd(12.345, 0.5), '12.3 ±0.5 t/s')
  assert.equal(fmtTpsMeanStd(80, 0), '80.0 ±0.0 t/s')
  // ≥100 t/s (desktop Bergamot regime): drop to integer, the extra decimal is noise at that scale.
  assert.equal(fmtTpsMeanStd(249.62, 8.16), '250 ±8 t/s')
})

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

test('renderMarkdown: empty groups → explains why and returns non-empty markdown', () => {
  const md = renderMarkdown([], {
    model: 'Unbabel/wmt22-comet-da',
    runs: 6,
    generatedAt: '2026-04-23T12:00:00Z'
  })
  assert.ok(md.includes('No scorable triples found'))
  assert.ok(md.includes('nmtcpp COMET Quality Report'))
})

test('renderMarkdown: with groups renders the aggregated table', () => {
  const groups = [
    { test: '[Bergamot] [CPU]', canonicalDevice: 'linux/x64 (hosted)', platform: 'linux', arch: 'x64',
      runs: 6, chrfppCount: 6, chrfppMean: 0.97, chrfppStd: 0, cometCount: 6, cometMean: 0.983, cometStd: 0,
      tpsCount: 6, tpsMean: 249.62, tpsStd: 8.16 },
    { test: '[IndicTrans] [CPU]', canonicalDevice: 'Apple iPhone 16 Pro', platform: 'ios', arch: 'arm64',
      runs: 2, chrfppCount: 2, chrfppMean: 0.228, chrfppStd: 0, cometCount: 2, cometMean: 0.509, cometStd: 0,
      tpsCount: 2, tpsMean: 11.4, tpsStd: 0.2 }
  ]
  const md = renderMarkdown(groups, {
    model: 'Unbabel/wmt22-comet-da',
    runs: 6,
    generatedAt: '2026-04-23T12:00:00Z'
  })
  assert.ok(md.includes('| Test | Device | Runs | chrF++ (mean ±std) | COMET (mean ±std) | TPS (mean ±std) |'))
  assert.ok(!/Δ|COMET − chrF|(\d)pp\b/.test(md), 'no Δ/pp artefacts')
  // Aggregated linux row must appear once with runs=6 and the full metric triplet
  assert.ok(md.includes('linux/x64 (hosted) | 6 | 97.0% ±0.0%'))
  assert.ok(md.includes('250 ±8 t/s'), 'TPS cell renders on the desktop row')
  // Mobile row
  assert.ok(md.includes('Apple iPhone 16 Pro | 2 | 22.8% ±0.0%'))
  assert.ok(md.includes('0.509 ±0.000'))
  assert.ok(md.includes('11.4 ±0.2 t/s'), 'TPS cell renders on the mobile row')
  assert.ok(md.includes('QVAC-16488'))
})

test('renderMarkdown: COMET-skipped → COMET cell "-", TPS cell still rendered', () => {
  const groups = [
    { test: '[Bergamot] [CPU]', canonicalDevice: 'linux/x64 (hosted)', platform: 'linux', arch: 'x64',
      runs: 6, chrfppCount: 6, chrfppMean: 0.97, chrfppStd: 0, cometCount: 0, cometMean: null, cometStd: 0,
      tpsCount: 6, tpsMean: 249.62, tpsStd: 8.16 }
  ]
  const md = renderMarkdown(groups, {
    model: 'm',
    runs: 6,
    generatedAt: '2026-04-23T12:00:00Z',
    skipComet: true
  })
  assert.ok(md.includes('COMET scoring skipped'))
  assert.ok(md.includes('97.0% ±0.0%'))
  assert.ok(md.includes('250 ±8 t/s'), 'TPS is an independent signal and still renders when COMET is skipped')
  const tableLine = md.split('\n').find(l => l.includes('[Bergamot] [CPU]'))
  assert.ok(tableLine.includes('| - | 250 ±8 t/s |'), 'missing COMET mean shows as "-" immediately before TPS cell')
  assert.ok(!md.includes('COMET scoring failed'), 'no failure banner when skip was explicit')
})

test('renderMarkdown: cometFailed=true → failure banner appears', () => {
  const groups = [
    { test: '[Bergamot] [CPU]', canonicalDevice: 'iPhone 16 Pro', platform: 'ios', arch: 'arm64',
      runs: 1, chrfppCount: 1, chrfppMean: 0.97, chrfppStd: 0, cometCount: 0, cometMean: null, cometStd: 0,
      tpsCount: 1, tpsMean: 83.77, tpsStd: 0 }
  ]
  const md = renderMarkdown(groups, {
    model: 'm',
    runs: 6,
    generatedAt: '2026-04-23T12:00:00Z',
    cometFailed: true
  })
  assert.ok(md.includes('COMET scoring failed'))
})

test('renderMarkdown: row sort uses explicit \'en\' locale (deterministic on any runner)', () => {
  // Two devices whose order would flip under a non-en locale (e.g.
  // Turkish "i" vs "I"). Passing an explicit 'en' locale keeps the
  // ordering stable across macOS / ubuntu / Windows runners.
  const groups = [
    { test: '[Bergamot] [CPU]', canonicalDevice: 'ios-iphone-b', platform: 'ios', arch: 'arm64',
      runs: 1, chrfppMean: 0.97, chrfppStd: 0, cometMean: null, cometStd: 0, tpsMean: 80, tpsStd: 0 },
    { test: '[Bergamot] [CPU]', canonicalDevice: 'IOS-IPHONE-A', platform: 'ios', arch: 'arm64',
      runs: 1, chrfppMean: 0.97, chrfppStd: 0, cometMean: null, cometStd: 0, tpsMean: 80, tpsStd: 0 }
  ]
  const md = renderMarkdown(groups, { model: 'm', runs: 1, generatedAt: 't' })
  const aIdx = md.indexOf('IOS-IPHONE-A')
  const bIdx = md.indexOf('ios-iphone-b')
  assert.ok(aIdx > 0 && bIdx > 0)
  assert.ok(aIdx < bIdx, 'case-insensitive en ordering: A < b')
})

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

function runParseArgs (flags) {
  return parseArgs(['node', 'script.js', ...flags])
}

test('parseArgs: defaults when no flags', () => {
  const args = runParseArgs([])
  assert.equal(args.runs, 6)
  assert.equal(args.model, 'Unbabel/wmt22-comet-da')
  assert.equal(args.workflow, 'On PR Trigger (NMTCPP)')
  assert.equal(args.output, 'reports/nmtcpp-comet.md')
  assert.equal(args.repo, null)
  assert.equal(args.dir, null)
  assert.equal(args.skipComet, false)
})

test('parseArgs: --runs accepts positive integer', () => {
  assert.equal(runParseArgs(['--runs', '3']).runs, 3)
  assert.equal(runParseArgs(['--runs', '12']).runs, 12)
})

test('parseArgs: --runs 0 falls back to default (not silently 0)', () => {
  // Critical: previously `0 || DEFAULT` truthy-check meant --runs 0
  // was indistinguishable from --runs unset. Explicit guard now.
  assert.equal(runParseArgs(['--runs', '0']).runs, 6)
})

test('parseArgs: --runs with non-numeric value falls back to default', () => {
  assert.equal(runParseArgs(['--runs', 'abc']).runs, 6)
  assert.equal(runParseArgs(['--runs', '']).runs, 6)
})

test('parseArgs: --runs negative value falls back to default', () => {
  assert.equal(runParseArgs(['--runs', '-3']).runs, 6)
})

test('parseArgs: string flags pass through verbatim', () => {
  const args = runParseArgs([
    '--model', 'Unbabel/custom-model',
    '--output', '/tmp/out.md',
    '--workflow', 'Some Workflow',
    '--repo', 'owner/repo',
    '--dir', '/tmp/reports'
  ])
  assert.equal(args.model, 'Unbabel/custom-model')
  assert.equal(args.output, '/tmp/out.md')
  assert.equal(args.workflow, 'Some Workflow')
  assert.equal(args.repo, 'owner/repo')
  assert.equal(args.dir, '/tmp/reports')
})

test('parseArgs: --skip-comet is a boolean toggle', () => {
  assert.equal(runParseArgs([]).skipComet, false)
  assert.equal(runParseArgs(['--skip-comet']).skipComet, true)
})

test('parseArgs: unknown flags are silently ignored (matches aggregate.js)', () => {
  const args = runParseArgs(['--not-a-real-flag', 'value', '--runs', '2'])
  assert.equal(args.runs, 2)
})
