'use strict'

// A mobile load-mode cell whose backend probe THROWS must render as Failed.
//
// The cell records its load figures before the probe runs, and t.fail() only
// marks the TAP run — the consolidated report is built from the recorded row.
// A row carrying load figures and no status read as a measurement whose
// backend merely went unreported ("Backend unverified"), which is exactly
// what a platform that genuinely cannot report its backend looks like.
//
// This drives the real mobile path: _perf-helper.js's inline reporter, its
// [PERF_REPORT_START] console export (what Device Farm logs carry), and the
// renderer's CLI over that export.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { execFileSync } = require('node:child_process')

const HELPER = path.resolve(__dirname, '..', '..', '..', 'test', 'integration', '_perf-helper.js')
const RENDERER = path.resolve(__dirname, '..', 'render-report.js')
const MB = 1024 * 1024

// Load the helper as it runs on a phone: bare-* modules backed by node's, the
// platform reported as iOS, and the shared desktop reporter unreachable so the
// inline mobile reporter is the one in use.
function loadMobileHelper() {
  const shims = {
    'bare-fs': fs,
    'bare-path': path,
    'bare-os': { ...os, platform: () => 'ios', arch: () => 'arm64' },
    // No exit hook: the on-device artifact write is not under test, and
    // letting it run would leave a report file behind on the host.
    'bare-process': { env: process.env, on: () => {} }
  }
  const mod = new Module(HELPER)
  mod.filename = HELPER
  mod.paths = Module._nodeModulePaths(path.dirname(HELPER))
  mod.require = (id) => {
    if (id in shims) return shims[id]
    if (id === 'bare-subprocess' || id.includes('performance-reporter')) {
      throw new Error(`unavailable on mobile: ${id}`)
    }
    return require(id)
  }
  mod._compile(fs.readFileSync(HELPER, 'utf8'), HELPER)
  return mod.exports
}

// Every [PERF_REPORT_START]…[PERF_REPORT_END] payload the helper emitted.
function captureReports(fn) {
  const lines = []
  const orig = console.log
  console.log = (...args) => lines.push(args.join(' '))
  try {
    fn()
  } finally {
    console.log = orig
  }
  return lines
    .map((l) => /\[PERF_REPORT_START\](.*)\[PERF_REPORT_END\]/.exec(l))
    .filter(Boolean)
    .map((m) => JSON.parse(m[1]))
}

function renderReport(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-probe-'))
  fs.writeFileSync(path.join(dir, 'performance-report.json'), JSON.stringify(doc))
  const out = execFileSync(process.execPath, [RENDERER, '--dir', dir], { encoding: 'utf8' })
  fs.rmSync(dir, { recursive: true, force: true })
  return out
}

const loadMetrics = {
  load_ms: 10594,
  rss_bytes: 646 * MB,
  rss_anon_bytes: null,
  rss_file_bytes: null,
  locked_bytes: null
}

function recordCell(helper, mode, status) {
  return captureReports(() => {
    helper.recordPerformance(`[qwen3.5-0.8b-Q4_0] [gpu] [rb=-1] [kv=f16] [lm=${mode}]`, null, {
      // A thrown probe leaves stats null, so no backend is observed.
      stats: null,
      deviceId: 'gpu',
      scenario: 'benchmark-perf',
      model: `qwen3.5-0.8b-Q4_0-f16-lm${mode}-gpu-rb-1`,
      loadMetrics,
      status
    })
  })
}

test('a thrown mobile probe persists its failure and renders as Failed', () => {
  const helper = loadMobileHelper()
  const [report] = recordCell(helper, 'auto', 'crashed')
  assert.ok(report, 'the helper emitted a console report')
  assert.strictEqual(report.results[0].status, 'crashed', 'the status survives the console export')

  const md = renderReport({ ...report, device: { name: 'Apple iPhone 16' } })
  assert.match(md, /\| `auto` \| - \| - \| - \| - \| - \| - \| - \| Failed \|/, 'the cell renders as Failed')
  assert.doesNotMatch(md, /Backend unverified/, 'not as a measurement with an unreported backend')
})

test('a probe that returned nothing but did not throw stays unverified', () => {
  // The distinction the status exists to keep: no backend reported is a
  // platform limitation, a thrown probe is a harness failure.
  const helper = loadMobileHelper()
  const [report] = recordCell(helper, 'auto', null)
  assert.strictEqual(report.results[0].status, null, 'no status on a cell that did not fail')

  const md = renderReport({ ...report, device: { name: 'Apple iPhone 16' } })
  assert.match(md, /Backend unverified/, 'an unreported backend is flagged, not failed')
})
