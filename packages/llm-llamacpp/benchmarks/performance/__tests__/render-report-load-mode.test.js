'use strict'

// End-to-end test of the load-mode section through the PRODUCTION path:
// mobile perf-report JSON on disk -> loadDir() -> aggregate() -> rendered
// Markdown.
//
// It exists because a previous version of this section was verified by calling
// loadModeSection() directly, which bypassed aggregate(). aggregate() rebuilds
// every row from a fixed field list, so it silently dropped load_ms and the RSS
// deltas and every load-mode column rendered empty. Testing the function
// instead of the pipeline hid that completely.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const RENDERER = path.resolve(__dirname, '..', 'render-report.js')
const MB = 1024 * 1024

function perfReport(device, results) {
  return { device: { name: device }, addon: 'llamacpp-llm', results }
}

// One result row as the mobile reporter emits it.
function row(config, overrides = {}) {
  // Both device fields, as the live reporters now emit them: the label says
  // what was requested and the backend confirms what ran. A fixture without
  // them is a pre-field artifact, covered by its own test below.
  const requested = /\[cpu\]/.test(config) ? 'cpu' : /\[gpu\]/.test(config) ? 'gpu' : null
  return {
    test: config,
    status: 'passed',
    execution_provider: requested,
    requested_device: requested,
    metrics: {
      ttft_ms: 100,
      tps: 20,
      pp_tps: 300,
      generated_tokens: 64,
      load_ms: 800,
      rss_bytes: 480 * MB,
      rss_anon_bytes: 130 * MB,
      rss_file_bytes: 350 * MB,
      locked_bytes: 0,
      ...overrides
    }
  }
}

// The renderer runs main() on require, so load it in a sandbox to reach the
// internal key parser directly. Used only by the key-equality test; every
// other test here drives the real CLI.
function loadRenderer() {
  const src = fs.readFileSync(RENDERER, 'utf8')
  const wrapped = src.replace(/\nmain\(\)[\s\S]*$/, '\n') + '\nmodule.exports = { shardKeyOf }\n'
  const Module = require('node:module')
  const mod = new Module('render-report-under-test')
  mod.paths = Module._nodeModulePaths(path.dirname(RENDERER))
  mod.filename = RENDERER
  mod._compile(wrapped, RENDERER)
  return mod.exports
}

// Keys may contain '/' to place a file in a subdirectory, which is how the
// summarize job lays artifacts out: download-artifact unpacks each artifact
// into its own directory named after it.
function render(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-render-'))
  for (const [name, doc] of Object.entries(files)) {
    const target = path.join(dir, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(doc))
  }
  const out = execFileSync(process.execPath, [RENDERER, '--dir', dir], { encoding: 'utf8' })
  fs.rmSync(dir, { recursive: true, force: true })
  return out
}

// One desktop parameter-sweep case, in the schema llm-parameter-sweep.js writes.
function desktopSweep(modelId, tps) {
  return {
    repeats: 5,
    models: [
      {
        modelId,
        cases: [
          {
            isBaseline: false,
            quantization: 'Q4_0',
            status: 'ok',
            runtimeConfig: {
              device: 'gpu',
              'reasoning-budget': '-1',
              'cache-type-k': 'f16',
              'cache-type-v': 'f16',
              'ctx-size': '2048'
            },
            metrics: {
              ttftMsMean: 50,
              ttftMsStd: 1,
              tpsMean: tps,
              tpsStd: 1,
              ppTpsMean: 300,
              ppTpsStd: 1,
              generatedTokens: 64,
              repeats: 5
            }
          }
        ]
      }
    ]
  }
}

const LM = (mode, backend) => `[qwen3.5-0.8b-Q4_0] [${backend}] [rb=-1] [kv=f16] [lm=${mode}]`

test('load-mode metrics survive aggregation and reach the rendered table', () => {
  const md = render({
    'perf-pixel.json': perfReport('Pixel 8', [
      // Two repetitions of one cell: aggregate() collapses them, and the
      // per-load figures must survive rather than being averaged away.
      row(LM('auto', 'gpu'), { load_ms: 900, rss_bytes: 260 * MB, rss_anon_bytes: 120 * MB, rss_file_bytes: 135 * MB }),
      row(LM('auto', 'gpu'), { load_ms: 900, rss_bytes: 260 * MB, rss_anon_bytes: 120 * MB, rss_file_bytes: 135 * MB }),
      row(LM('mmap', 'gpu'), { load_ms: 700, rss_bytes: 450 * MB, rss_anon_bytes: 120 * MB, rss_file_bytes: 330 * MB })
    ])
  })

  assert.match(md, /## Load modes/, 'section is rendered')
  assert.match(md, /### Pixel 8 — gpu/, 'grouped by device and backend')
  // The regression this test exists for: a real load time in the table.
  assert.match(md, /\| `auto` \| 900 \|/, 'auto load time survives aggregation')
  assert.match(md, /\| `mmap` \| 700 \|/, 'mmap load time survives aggregation')
  assert.doesNotMatch(md, /undefined ms/, 'no undefined leaks into the winner line')
  assert.doesNotMatch(md, /null MiB/, 'no null leaks into the winner line')
  // No winner anywhere: the consolidated summary keeps one figure per cell and
  // cannot show the uncertainty a ranking would need. It reports the range and
  // the per-mode deltas, and leaves interpretation to docs/perf/load-mode.md.
  assert.doesNotMatch(md, /fastest load:/, 'no timing winner is crowned')
  assert.doesNotMatch(md, /lowest anonymous resident|lowest total resident/, 'no memory winner')
  assert.match(md, /load-time range: `mmap` 700 ms to `auto` 900 ms/, 'the range is stated instead')
  // Both margins: auto is the real default, mmap is named by the acceptance
  // criteria, and correcting the first does not remove the second.
  assert.match(md, /Δ vs auto/, 'margin against auto is present')
  assert.match(md, /Δ vs mmap/, 'margin against mmap is present')
})

test('gpu and cpu are reported separately, not collapsed', () => {
  const md = render({
    'perf-pixel.json': perfReport('Pixel 8', [
      row(LM('auto', 'gpu'), { load_ms: 900 }),
      row(LM('auto', 'cpu'), { load_ms: 1500 })
    ])
  })

  assert.match(md, /### Pixel 8 — gpu/, 'gpu table present')
  assert.match(md, /### Pixel 8 — cpu/, 'cpu table present')
  assert.match(md, /\| `auto` \| 900 \|/, 'gpu row kept')
  assert.match(md, /\| `auto` \| 1500 \|/, 'cpu row kept — not overwritten by gpu')
})

test('a mode with no row is flagged as a coverage gap, not omitted', () => {
  const md = render({
    'perf-pixel.json': perfReport('Pixel 8', [row(LM('auto', 'gpu'))])
  })

  assert.match(md, /\| `dio` \|.*Not measured \(coverage gap\)/, 'absent mode still gets a row')
  assert.match(md, /coverage gap: .*`none`/, 'missing modes are listed explicitly')
})

// Desktop cells are a median of five loads, so a fastest mode IS claimed
// there. Built with `desktop: true` — the flag aggregate() reads — because a
// mobile fixture would make every assertion here pass vacuously.
function desktopLoadModeReport(results) {
  return { device: { name: 'Desktop linux-x64' }, addon: 'llamacpp-llm', desktop: true, results }
}

function desktopRow(mode, loadMs) {
  return {
    test: `[qwen3.5-0.8b-Q4_0] [gpu] [rb=-1] [kv=f16] [lm=${mode}]`,
    status: 'passed',
    execution_provider: 'gpu',
    requested_device: 'gpu',
    metrics: {
      ttft_ms: null, tps: null, pp_tps: null, generated_tokens: null,
      load_ms: loadMs,
      rss_bytes: 500 * MB, rss_anon_bytes: 130 * MB, rss_file_bytes: 370 * MB, locked_bytes: 0
    }
  }
}

test('desktop reports a range too, and still crowns nothing', () => {
  // Desktop cells ARE a median of five, but the consolidated report does not
  // carry the sample count or spread, so it is not the place to declare a
  // winner either. The standalone sweep artifact has the statistics.
  const md = render({
    'load-mode-perf-linux-x64.json': desktopLoadModeReport([
      desktopRow('auto', 900),
      desktopRow('mmap', 700)
    ])
  })

  assert.match(md, /load-time range: `mmap` 700 ms to `auto` 900 ms/)
  assert.doesNotMatch(md, /fastest load:/, 'no verdict without the uncertainty to back it')
})

test('dio is labelled inert and kept out of the reported range', () => {
  const md = render({
    'load-mode-perf-linux-x64.json': desktopLoadModeReport([
      desktopRow('auto', 900),
      desktopRow('mmap', 700),
      // dio is the fastest number here and must not bound the range: it is an
      // alias of `none`, so presenting it as the floor would read as advice to
      // set an inert flag.
      desktopRow('dio', 100)
    ])
  })

  assert.match(md, /\| `dio` \|.*Inert \(fabric discards the flag\)/, 'dio labelled inert')
  assert.match(md, /\| `dio` \| 100 \|/, 'its measurement is still shown')
  assert.match(md, /load-time range: `mmap` 700 ms to `auto` 900 ms/, 'dio does not bound the range')
})

test('an mlock that locked nothing is not reported as a plain success', () => {
  const md = render({
    'perf-pixel.json': perfReport('Pixel 8', [
      row(LM('mlock', 'gpu'), { locked_bytes: 0 }),
      row(LM('mmap+mlock', 'gpu'), { locked_bytes: null })
    ])
  })

  assert.match(md, /\| `mlock` \|.*Measured \(lock had no effect\)/, 'zero lock is called out')
  assert.match(md, /\| `mmap\+mlock` \|.*Measured \(lock unverified\)/, 'absent counter is called out')
})

test('memory ranking prefers anonymous RSS where the platform reports it', () => {
  const md = render({
    'perf-pixel.json': perfReport('Pixel 8', [
      // mmap reads HIGHER total rss but LOWER anonymous: on linux/android the
      // mapped weights are file-backed and evictable, so ranking on total rss
      // would crown `none` for memory it does not truly cost.
      row(LM('mmap', 'gpu'), { rss_bytes: 480 * MB, rss_anon_bytes: 120 * MB, rss_file_bytes: 350 * MB }),
      row(LM('none', 'gpu'), { rss_bytes: 300 * MB, rss_anon_bytes: 280 * MB, rss_file_bytes: 20 * MB })
    ])
  })

  // The consolidated report no longer ranks, so what must survive is the
  // DATA that makes the inversion visible: mmap higher on total rss, lower on
  // anonymous. A reader (and docs/perf/load-mode.md) draws the conclusion.
  assert.match(md, /\| `mmap` \|.*\| 480 \| 120 \| 350 \|/, 'mmap: high rss, low anon')
  assert.match(md, /\| `none` \|.*\| 300 \| 280 \| 20 \|/, 'none: low rss, high anon')
  assert.doesNotMatch(md, /lowest anonymous resident|lowest total resident/, 'no memory winner')
})

test('a platform without /proc ranks total rss and says so', () => {
  const md = render({
    'perf-iphone.json': perfReport('iPhone 15', [
      row(LM('auto', 'gpu'), { rss_bytes: 400 * MB, rss_anon_bytes: null, rss_file_bytes: null }),
      row(LM('mmap', 'gpu'), { rss_bytes: 500 * MB, rss_anon_bytes: null, rss_file_bytes: null })
    ])
  })

  // No /proc: anon and file must render as absent rather than as zero, which
  // would read as "this mode costs no anonymous memory".
  assert.match(md, /\| `auto` \|.*\| 400 \| - \| - \|/, 'absent counters render as -, not 0')
  assert.match(md, /\| `mmap` \|.*\| 500 \| - \| - \|/)
  assert.doesNotMatch(md, /\| 0 \| 0 \|/, 'nulls must not become zeros')
})

test('a crashed mode is reported as failing, not as a coverage gap', () => {
  const md = render({
    'perf-pixel.json': perfReport('Pixel 8', [
      {
        test: LM('mlock', 'gpu'),
        status: 'crashed',
        metrics: { ttft_ms: null, tps: null, pp_tps: null }
      },
      row(LM('auto', 'gpu'))
    ])
  })

  assert.match(md, /\| `mlock` \|.*Failed \|/, 'crashed mode reported as failing')
})

// Coverage reconciliation is a separate failure surface from the load-mode
// table: it compares the key the report parser derives from a row label
// against the key the matrix generated the shard from. The two are built by
// different functions in different files, and nothing else forces them to
// agree — a mismatch reports every load-mode shard as missing on a run where
// all of them succeeded, while the load-mode table itself still renders fine.
test('load-mode shard keys reconcile against the matrix run-meta', () => {
  const { matrix, mobileShardKey } = require('../../../test/integration/_benchmark-matrix.js')
  const lmCells = matrix().filter((c) => c.loadMode !== undefined)
  assert.equal(lmCells.length, 12, 'six modes x two backends')

  // Report one real result for every load-mode shard the matrix expects.
  const results = lmCells.map((c) => row(LM(c.loadMode, c.loadDevice)))
  const md = render({
    'run-meta.json': { expectedShards: matrix().map(mobileShardKey) },
    'perf-pixel.json': perfReport('Pixel 8', results)
  })

  for (const c of lmCells) {
    const key = mobileShardKey(c)
    assert.ok(
      !md.includes(`${key.split('|')[0]} [kv=f16] [lm=${c.loadMode}] [${c.loadDevice}]`) ||
        !/Missing shards|not reported/i.test(md),
      `shard ${key} should not be reported as missing`
    )
  }
  assert.doesNotMatch(
    md,
    /\[lm=auto\] \[gpu\][^\n]*missing/i,
    'a shard that ran is not listed as missing'
  )
})

test('shardKeyOf reproduces the key mobileShardKey generated', () => {
  const { matrix, mobileShardKey } = require('../../../test/integration/_benchmark-matrix.js')
  const { shardKeyOf } = loadRenderer()
  for (const c of matrix().filter((x) => x.loadMode !== undefined)) {
    const config = LM(c.loadMode, c.loadDevice)
    assert.equal(
      shardKeyOf(config),
      mobileShardKey(c),
      `parsed key for "${config}" must equal the matrix key`
    )
  }
})

// The desktop load-mode runner emits a report with load and memory figures but
// no TTFT/TPS, because it never generates a token. The mobile parser's crash
// heuristic was "no throughput means crashed", which reported every one of
// those successful measurements as Failed. Caught only by running the real
// runner's output through the real CLI; the fixture below is that output.
test('desktop load-mode report renders as measured, not crashed', () => {
  const desktopReport = {
    device: { name: 'Desktop linux-x64' },
    addon: 'llamacpp-llm',
    results: [
      {
        test: '[qwen3.5-0.8b-Q4_0] [gpu] [rb=-1] [kv=f16] [lm=auto]',
        status: 'passed',
        execution_provider: 'gpu',
        requested_device: 'gpu',
        metrics: {
          ttft_ms: null,
          tps: null,
          pp_tps: null,
          generated_tokens: null,
          load_ms: 788.3,
          rss_bytes: 506458112,
          rss_anon_bytes: 131710976,
          rss_file_bytes: 375320576,
          locked_bytes: 0
        }
      }
    ]
  }
  const md = render({ 'load-mode-perf-linux-x64.json': desktopReport })

  assert.match(md, /### Desktop linux-x64 — gpu/, 'desktop leg carries its own platform identity')
  assert.match(md, /\| `auto` \| 788\.3 \|.*Measured \|/, 'a throughput-less load row is measured, not failed')
  assert.doesNotMatch(md, /\| `auto` \|.*Failed \|/, 'not reported as a failure')
})

test('a row with neither throughput nor load figures is still crashed', () => {
  const md = render({
    'perf-pixel.json': perfReport('Pixel 8', [
      {
        test: LM('mmap', 'gpu'),
        status: 'passed',
        metrics: { ttft_ms: null, tps: null, pp_tps: null, load_ms: null, rss_bytes: null }
      },
      row(LM('auto', 'gpu'))
    ])
  })

  assert.match(md, /\| `mmap` \|.*Failed \|/, 'an empty row is still a failure')
})

// A multi-platform desktop matrix uploads one artifact per leg, each with its
// own desktop-meta.json. A single global device name would label every leg's
// throughput rows with whichever stamp was read first, and aggregate() would
// then merge identical configs from different platforms into one row.
test('desktop platforms are not collapsed into one device', () => {
  const md = render({
    'llm-param-sweep-desktop-linux-x64-1/desktop-meta.json': { desktopDevice: 'Desktop linux-x64 (RTX 5080)' },
    'llm-param-sweep-desktop-linux-x64-1/sweep.json': desktopSweep('qwen3.5-0.8b', 40),
    'llm-param-sweep-desktop-win32-x64-1/desktop-meta.json': { desktopDevice: 'Desktop win32-x64 (RTX 4000)' },
    'llm-param-sweep-desktop-win32-x64-1/sweep.json': desktopSweep('qwen3.5-0.8b', 31)
  })

  assert.match(md, /Desktop linux-x64 \(RTX 5080\)/, 'linux leg keeps its own name')
  assert.match(md, /Desktop win32-x64 \(RTX 4000\)/, 'windows leg keeps its own name')
  // Both throughput numbers must survive: a collapse would keep one and
  // silently discard the other, since the configs are identical.
  assert.match(md, /\b40\b/, 'linux tps present')
  assert.match(md, /\b31\b/, 'windows tps present')

  // Neither leg may be counted as a phone. Classification used to be
  // "device name != the one desktopDevice", so every leg after the first got a
  // mobile shard-coverage row and a missing-shard count for a matrix it never
  // ran, and leaked into the mobile charts.
  const coverage = md.slice(md.indexOf('## Coverage'), md.indexOf('##', md.indexOf('## Coverage') + 3))
  assert.doesNotMatch(coverage, /win32-x64/, 'windows leg is not in mobile coverage')
  assert.doesNotMatch(coverage, /linux-x64/, 'linux leg is not in mobile coverage')
  assert.match(md, /0 mobile devices reported/i, 'a desktop-only run reports no mobile devices')
})

// The focused load-mode dispatch is the case that broke hardest: the stamp
// carries the detected GPU while the load report's own device name does not,
// so a name comparison classified even the first desktop leg as a phone.
test('a load-mode-only desktop run is not classified as mobile', () => {
  const md = render({
    'llm-param-sweep-desktop-linux-x64-1/desktop-meta.json': { desktopDevice: 'Desktop linux-x64 (RTX 5080)' },
    'llm-param-sweep-desktop-linux-x64-1/load-mode-perf-linux-x64.json': {
      device: { name: 'Desktop linux-x64' },
      desktop: true,
      addon: 'llamacpp-llm',
      results: [
        {
          test: '[qwen3.5-0.8b-Q4_0] [gpu] [rb=-1] [kv=f16] [lm=auto]',
          status: 'passed',
          metrics: {
            ttft_ms: null, tps: null, pp_tps: null, generated_tokens: null,
            load_ms: 788.3, rss_bytes: 506458112,
            rss_anon_bytes: 131710976, rss_file_bytes: 375320576, locked_bytes: 0
          }
        }
      ]
    }
  })

  assert.match(md, /### Desktop linux-x64 — gpu/, 'load-mode section renders the desktop leg')
  const coverage = md.slice(md.indexOf('## Coverage'), md.indexOf('##', md.indexOf('## Coverage') + 3))
  assert.doesNotMatch(coverage, /Desktop linux-x64\b.*\d+\/\d+/, 'no mobile shard count for a desktop leg')
  assert.match(md, /0 mobile devices reported/i, 'desktop-only load-mode run has no mobile devices')
})

test('a single-platform layout still resolves one desktop device', () => {
  const md = render({
    'desktop-meta.json': { desktopDevice: 'Desktop (RTX 5080)' },
    'sweep.json': desktopSweep('qwen3.5-0.8b', 40)
  })
  assert.match(md, /Desktop \(RTX 5080\)/, 'unchanged for the existing single-leg layout')
})

// darwin and win32 have no /proc, so anon/file/locked are unavailable. They
// must stay absent rather than averaging to a measured-looking zero.
test('absent memory counters are not reported as zero', () => {
  const md = render({
    'perf-mac.json': {
      device: { name: 'Desktop darwin-arm64' },
      addon: 'llamacpp-llm',
      results: [
        {
          test: '[qwen3.5-0.8b-Q4_0] [gpu] [rb=-1] [kv=f16] [lm=mlock]',
          status: 'passed',
          execution_provider: 'gpu',
          requested_device: 'gpu',
          metrics: {
            ttft_ms: null, tps: null, pp_tps: null, generated_tokens: null,
            load_ms: 700, rss_bytes: 400 * MB,
            rss_anon_bytes: null, rss_file_bytes: null, locked_bytes: null
          }
        }
      ]
    }
  })

  assert.match(md, /\| `mlock` \|.*Measured \(lock unverified\)/, 'unverifiable lock says so')
  assert.doesNotMatch(md, /lock had no effect/, 'absent counter is not read as a zero lock')
})

// A narrowed dispatch must not read as a broken one: modes it deliberately
// left out are "not selected", and only a mode that WAS selected and produced
// nothing counts as a coverage gap.
test('unselected modes are not reported as coverage gaps', () => {
  const md = render({
    'run-meta.json': {
      addonVersion: '@qvac/llm-llamacpp@0.53.2',
      sweepParams: 'load-mode=auto|mmap',
      expectedShards: [
        'qwen3.5-0.8b-Q4_0|f16|lmauto|gpu',
        'qwen3.5-0.8b-Q4_0|f16|lmmmap|gpu'
      ]
    },
    'perf-pixel.json': perfReport('Pixel 8', [
      row(LM('auto', 'gpu')),
      row(LM('mmap', 'gpu'))
    ])
  })

  assert.match(md, /\| `none` \|.*Not selected for this run/, 'unselected mode is labelled, not flagged')
  assert.doesNotMatch(md, /\| `none` \|.*coverage gap/, 'not a gap — it was never asked for')
  assert.doesNotMatch(md, /coverage gap: /, 'no gap summary when nothing selected is missing')
})

test('a selected mode that produced nothing IS a coverage gap', () => {
  const md = render({
    'run-meta.json': {
      addonVersion: '@qvac/llm-llamacpp@0.53.2',
      expectedShards: [
        'qwen3.5-0.8b-Q4_0|f16|lmauto|gpu',
        'qwen3.5-0.8b-Q4_0|f16|lmmmap|gpu'
      ]
    },
    // mmap was selected but never reported.
    'perf-pixel.json': perfReport('Pixel 8', [row(LM('auto', 'gpu'))])
  })

  assert.match(md, /\| `mmap` \|.*coverage gap/, 'selected-but-absent is still a gap')
  assert.match(md, /coverage gap: .*`mmap`/, 'and is listed in the summary')
})

test('cross-product rows never leak into the load-mode section', () => {
  const md = render({
    'perf-pixel.json': perfReport('Pixel 8', [
      row('[qwen3.5-0.8b-Q8_0] [gpu] [rb=-1] [kv=q8_0]', { load_ms: 4242 })
    ])
  })

  assert.doesNotMatch(md, /## Load modes/, 'no load-mode section without load-mode rows')
  assert.doesNotMatch(md, /4242/, 'a cross-product load time is not rendered as a load-mode result')
})

// ── Backend verification, end to end ────────────────────────────────────────
// Classification was tested in the runner in isolation, which said nothing
// about whether the verdict survives to the GitHub summary. It did not: the
// emitter collapsed every non-crash state to `passed` and labelled the row
// with the requested device when the observed one was unknown, so an
// unverified CPU fallback rendered as a passed GPU measurement.

function lmRow(mode, { requested = 'gpu', observed = 'gpu', loadMs = 700 } = {}) {
  return {
    test: `[qwen3.5-0.8b-Q4_0] [${requested}] [rb=-1] [kv=f16] [lm=${mode}]`,
    status: 'passed',
    execution_provider: observed,
    requested_device: requested,
    metrics: {
      ttft_ms: null, tps: null, pp_tps: null, generated_tokens: null,
      load_ms: loadMs,
      rss_bytes: 500 * MB, rss_anon_bytes: 130 * MB, rss_file_bytes: 370 * MB, locked_bytes: 0
    }
  }
}

function desktopDoc(results) {
  return { device: { name: 'Desktop linux-x64' }, addon: 'llamacpp-llm', desktop: true, results }
}

test('a GPU request that ran on the CPU is not published as a GPU measurement', () => {
  const md = render({
    'load-mode-perf-linux-x64.json': desktopDoc([
      lmRow('auto', { requested: 'gpu', observed: 'cpu', loadMs: 900 })
    ])
  })
  assert.match(md, /Ran on cpu, not gpu — not comparable/, 'the fallback is stated in the table')
  assert.doesNotMatch(md, /\| `auto` \| 900 \|.*\| Measured \|/, 'must not read as a plain measurement')
})

test('a backend that could not be confirmed is flagged, not assumed to match', () => {
  // The darwin-x64 shape: loaded fine, reported no backend at all.
  const md = render({
    'load-mode-perf-linux-x64.json': desktopDoc([
      lmRow('auto', { requested: 'gpu', observed: null, loadMs: 2602 })
    ])
  })
  assert.match(md, /Backend unverified/, 'unknown is reported as unknown')
  assert.doesNotMatch(md, /\| `auto` \| 2602 \|.*\| Measured \|/, 'unknown must not read as confirmed')
})

test('a confirmed match still renders as a plain measurement', () => {
  const md = render({
    'load-mode-perf-linux-x64.json': desktopDoc([
      lmRow('auto', { requested: 'gpu', observed: 'gpu', loadMs: 700 })
    ])
  })
  assert.match(md, /\| `auto` \| 700 \|.*\| Measured \|/, 'a verified row is unaffected')
  assert.doesNotMatch(md, /Backend unverified|not comparable/)
})

test('mobile carries the same verification, from its own execution_provider', () => {
  // The mobile helper records execution_provider but the renderer ignored it
  // and derived the backend from the test label, so a phone falling back to
  // CPU appeared under the requested backend exactly as desktop did.
  const md = render({
    'perf-pixel.json': perfReport('Pixel 8', [
      { ...lmRow('auto', { requested: 'gpu', observed: 'cpu', loadMs: 950 }) }
    ])
  })
  assert.match(md, /Ran on cpu, not gpu — not comparable/, 'mobile rows are checked too')
})

test('integrated and dedicated main-gpu rows do not collide', () => {
  // On a host with both GPU classes the same mode is two different loads. The
  // runner labels them [mg=...]; keying only on device and backend made the
  // second silently overwrite the first, showing one unexplained figure.
  const mg = (mode, cls, loadMs) => ({
    test: `[qwen3.5-0.8b-Q4_0] [gpu] [rb=-1] [kv=f16] [lm=${mode}] [mg=${cls}]`,
    status: 'passed',
    execution_provider: 'gpu',
    requested_device: 'gpu',
    metrics: {
      ttft_ms: null, tps: null, pp_tps: null, generated_tokens: null,
      load_ms: loadMs,
      rss_bytes: 500 * MB, rss_anon_bytes: 130 * MB, rss_file_bytes: 370 * MB, locked_bytes: 0
    }
  })

  const md = render({
    'load-mode-perf-linux-x64.json': desktopDoc([
      mg('auto', 'integrated', 738),
      mg('auto', 'dedicated', 764)
    ])
  })

  assert.match(md, /main-gpu: integrated/, 'the integrated group is rendered')
  assert.match(md, /main-gpu: dedicated/, 'the dedicated group is rendered')
  assert.match(md, /\| `auto` \| 738 \|/, 'the integrated measurement survives')
  assert.match(md, /\| `auto` \| 764 \|/, 'the dedicated measurement survives')
})

test('a non-comparable row is excluded from deltas, baselines and the range', () => {
  // Labelling the row is not enough. If it can serve as a baseline, take a
  // margin, or bound the load-time range, a number nobody can interpret
  // leaks into every other row's arithmetic.
  const md = render({
    'load-mode-perf-linux-x64.json': desktopDoc([
      // auto ran somewhere else: it must not become the Δ-vs-auto baseline.
      lmRow('auto', { requested: 'gpu', observed: 'cpu', loadMs: 3000 }),
      lmRow('mmap', { requested: 'gpu', observed: 'gpu', loadMs: 700 }),
      lmRow('none', { requested: 'gpu', observed: 'gpu', loadMs: 1900 }),
      // unverified, and the fastest number present — must not bound the range
      lmRow('mlock', { requested: 'gpu', observed: null, loadMs: 100 })
    ])
  })

  assert.match(md, /Ran on cpu, not gpu/, 'the mismatched row is still shown and labelled')
  assert.match(md, /Backend unverified/, 'the unverified row is still shown and labelled')
  // Δ vs auto is unavailable for EVERY row, because auto itself is not
  // comparable — the column reads '-', never a percentage.
  assert.match(md, /\| `mmap` \| 700 \| - \| — \|/, 'no Δ vs auto; Δ vs mmap is its own baseline')
  assert.match(md, /\| `none` \| 1900 \| - \| \+171\.4% \|/, 'Δ vs mmap still computed from a verified row')
  // The range spans only the two verified rows.
  assert.match(md, /load-time range: `mmap` 700 ms to `none` 1900 ms/, 'only comparable rows bound it')
  assert.doesNotMatch(md, /range: `mlock`/, 'an unverified row cannot be the floor')
})

test('an artifact predating the device fields renders as unverified, not verified', () => {
  // Both fields are required, so a pre-field artifact cannot be shown to have
  // run where it was asked to. Reporting it as a plain measurement would be
  // the same false confidence this check exists to remove — the honest
  // rendering is "unverified", and it must not feed the deltas or the range.
  const md = render({
    'legacy.json': {
      device: { name: 'Desktop linux-x64' },
      addon: 'llamacpp-llm',
      desktop: true,
      results: [
        {
          test: '[qwen3.5-0.8b-Q4_0] [gpu] [rb=-1] [kv=f16] [lm=auto]',
          status: 'passed',
          metrics: {
            ttft_ms: null, tps: null, pp_tps: null, generated_tokens: null,
            load_ms: 800, rss_bytes: 500 * MB,
            rss_anon_bytes: 130 * MB, rss_file_bytes: 370 * MB, locked_bytes: 0
          }
        },
        {
          test: '[qwen3.5-0.8b-Q4_0] [gpu] [rb=-1] [kv=f16] [lm=mmap]',
          status: 'passed',
          metrics: {
            ttft_ms: null, tps: null, pp_tps: null, generated_tokens: null,
            load_ms: 700, rss_bytes: 500 * MB,
            rss_anon_bytes: 130 * MB, rss_file_bytes: 370 * MB, locked_bytes: 0
          }
        }
      ]
    }
  })

  assert.match(md, /\| `auto` \| 800 \|.*Backend unverified/, 'no device fields means unverified')
  assert.match(md, /\| `mmap` \| 700 \|.*Backend unverified/)
  assert.doesNotMatch(md, /load-time range:/, 'unverified rows cannot bound a range')
})
