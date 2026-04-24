#!/usr/bin/env node
'use strict'

/**
 * COMET scoring for NMT translations captured in the weekly perf-report.
 *
 * ONLY runs in the `.github/workflows/perf-report.yml` weekly aggregate
 * job on a Linux GitHub-hosted runner — never in per-PR desktop or
 * per-PR mobile integration tests.
 *
 * Flow:
 *   1. Mirror aggregate.js and pull the last N completed + successful
 *      runs of "On PR Trigger (NMTCPP)" via the shared
 *      `./gh-artifacts` helpers, giving us each run's
 *      `performance-report.json`(s).
 *   2. Walk those reports, collect (test, device, input, output,
 *      reference, chrfpp, tps) triples. No per-run dedup here — all
 *      triples feed into aggregation so mean / std / run counts are
 *      computed over the full window.
 *   3. Write src/mt/ref lines in a single pass into /tmp/{src,mt,ref}.txt
 *      in the 1-line-per-sentence shape unbabel-comet's `comet-score`
 *      CLI expects.
 *   4. Shell out to `comet-score -s … -t … -r … --model …`, parse the
 *      per-sentence scores, merge them back onto the triples.
 *   5. Render reports/nmtcpp-comet.md with a
 *      `Test | Device | Runs | chrF++ | COMET | TPS` table (each
 *      numeric column aggregated as mean ± std across the window).
 *   6. Always exit 0. Any failure in COMET setup / model download /
 *      scoring is reported but does NOT fail the workflow — the
 *      chrF++ report produced by aggregate.js must still ship.
 *
 * Usage:
 *   node scripts/perf-report/comet-score-nmt.js [--runs N]
 *                                               [--model NAME]
 *                                               [--output PATH]
 *                                               [--repo OWNER/REPO]
 *                                               [--dir LOCAL_DIR]
 *                                               [--skip-comet]
 *
 * Flags:
 *   --runs N       last N completed + successful runs of
 *                  "On PR Trigger (NMTCPP)" to harvest. Defaults to
 *                  6 (matches aggregate.js).
 *   --model NAME   HuggingFace model id. Default Unbabel/wmt22-comet-da.
 *   --output PATH  Markdown output. Default reports/nmtcpp-comet.md.
 *   --repo OWNER/REPO  Passed through to gh.
 *   --dir LOCAL_DIR    Skip `gh` download; read performance-report.json
 *                      files recursively from this local dir instead
 *                      (used by the unit test + for local dev).
 *   --skip-comet   Collect + render the markdown with chrF++ only but
 *                  no COMET column. Used by the unit test so it can
 *                  verify the non-network code path.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { listWorkflowRuns, downloadRunArtifactsParallel, collectReportsFromDir } = require('./gh-artifacts')
const { mean, stddev } = require('./utils')

// `On PR Trigger (NMTCPP)` is the umbrella workflow that actually runs
// per-PR integration tests (including the one that emits perf-report-*
// artifacts). The inner `Integration Tests (NMTCPP)` is invoked via
// `workflow_call` and its artifacts surface under the umbrella run,
// not the inner one — so we query the umbrella by default.
const DEFAULT_WORKFLOW = 'On PR Trigger (NMTCPP)'
const DEFAULT_RUNS = 6
const DEFAULT_MODEL = 'Unbabel/wmt22-comet-da'
const DEFAULT_OUTPUT = 'reports/nmtcpp-comet.md'
const DEFAULT_DOWNLOAD_CONCURRENCY = 3

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

/**
 * Parses argv into the known flag shape. Unknown flags are silently
 * ignored (matches aggregate.js's behaviour). Invalid `--runs`
 * (0, negative, non-numeric) falls back to DEFAULT_RUNS with a
 * warning so a caller passing "--runs 0" doesn't quietly aggregate
 * the default 6.
 *
 * Exported for the unit test.
 */
function parseArgs (argv) {
  const args = {
    runs: DEFAULT_RUNS,
    model: DEFAULT_MODEL,
    output: DEFAULT_OUTPUT,
    workflow: DEFAULT_WORKFLOW,
    repo: null,
    dir: null,
    skipComet: false
  }
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--runs': {
        const n = parseInt(argv[++i], 10)
        if (!Number.isFinite(n) || n <= 0) {
          console.error(`  --runs must be a positive integer, got ${JSON.stringify(argv[i])}; falling back to ${DEFAULT_RUNS}`)
          args.runs = DEFAULT_RUNS
        } else {
          args.runs = n
        }
        break
      }
      case '--model': args.model = argv[++i]; break
      case '--output': args.output = argv[++i]; break
      case '--workflow': args.workflow = argv[++i]; break
      case '--repo': args.repo = argv[++i]; break
      case '--dir': args.dir = argv[++i]; break
      case '--skip-comet': args.skipComet = true; break
    }
  }
  return args
}

// ---------------------------------------------------------------------------
// Triple extraction
// ---------------------------------------------------------------------------

/**
 * Collapses an ephemeral runner name to a stable per-matrix-row label
 * so the weekly aggregate doesn't end up with one row per VM.
 *
 *   `GitHub Actions 1000320663` + platform=linux arch=x64
 *     → `linux/x64 (hosted)`
 *   `ai-run-windows11-gpu-1000320651`
 *     → `ai-run-windows11-gpu`           (strip trailing 6+ digit suffix)
 *   `Apple iPhone 16 Pro`, `Google Pixel 9`, `Samsung Galaxy S25 Ultra`
 *     → unchanged (these are already stable device model names)
 *
 * @param {string} name
 * @param {string} platform
 * @param {string} arch
 * @returns {string}
 */
function canonicalDeviceLabel (name, platform, arch) {
  if (!name) return `${platform || '?'}/${arch || '?'} (hosted)`
  if (/^GitHub Actions \d+$/.test(name)) {
    return `${platform || '?'}/${arch || '?'} (hosted)`
  }
  // Self-hosted runners: `ai-run-windows11-gpu-1000320651` → `ai-run-windows11-gpu`
  const m = name.match(/^(.+?)-\d{6,}$/)
  if (m) return m[1]
  return name
}

/**
 * Converts an array of perf reports into a flat array of scoring
 * triples. All triples are retained (no dedup here — dedup /
 * aggregation by `(canonicalDevice, test)` happens in `aggregateGroups`).
 *
 * A triple is only emitted if it has non-empty `input`, `output`,
 * AND `reference` — COMET's reference-based model can't score
 * incomplete triples.
 *
 * @param {Array<object>} reports
 * @returns {Array<object>} triples with shape
 *   { test, device, canonicalDevice, platform, arch,
 *     src, mt, ref, chrfpp, tps }
 */
function extractTriples (reports) {
  const out = []
  for (const report of reports) {
    const dev = (report.device && report.device.name) || 'unknown'
    const platform = (report.device && report.device.platform) || ''
    const arch = (report.device && report.device.arch) || ''
    const canonicalDevice = canonicalDeviceLabel(dev, platform, arch)
    for (const r of report.results || []) {
      const src = (r.input || '').trim()
      const mt = (r.output || '').trim()
      const ref = (r.reference || (r.quality && r.quality.reference) || '').trim()
      if (!src || !mt || !ref) continue
      const metrics = r.metrics || {}
      out.push({
        test: r.test,
        device: dev,
        canonicalDevice,
        platform,
        arch,
        src,
        mt,
        ref,
        chrfpp: typeof metrics.chrfpp === 'number' ? metrics.chrfpp : null,
        tps: typeof metrics.tps === 'number' ? metrics.tps : null
      })
    }
  }
  return out
}

/**
 * Groups triples by `(canonicalDevice, test)` and summarises chrF++,
 * COMET, and TPS with mean ± std across the runs in each group.
 *
 * Mean / std are computed over the values that are actually present
 * (null scores are skipped; each group reports how many runs
 * contributed samples for each metric separately). Uses the shared
 * `utils.stddev` sample-variance formula (`n-1` denominator) — same
 * as the aggregate.js path, so the two reports don't disagree on
 * what "std = 0.03" means for a cell.
 *
 * @param {Array<object>} triples - output of extractTriples
 * @param {Array<number | null> | null} cometScores - one per triple
 * @returns {Array<object>} groups
 */
function aggregateGroups (triples, cometScores) {
  const byKey = new Map()
  for (let i = 0; i < triples.length; i++) {
    const t = triples[i]
    const key = `${t.canonicalDevice}|||${t.test}`
    if (!byKey.has(key)) {
      byKey.set(key, {
        canonicalDevice: t.canonicalDevice,
        platform: t.platform,
        arch: t.arch,
        test: t.test,
        chrfppValues: [],
        cometValues: [],
        tpsValues: [],
        runs: 0
      })
    }
    const g = byKey.get(key)
    g.runs++
    if (typeof t.chrfpp === 'number') g.chrfppValues.push(t.chrfpp)
    if (typeof t.tps === 'number') g.tpsValues.push(t.tps)
    const c = cometScores ? cometScores[i] : null
    if (typeof c === 'number') g.cometValues.push(c)
  }
  const out = []
  for (const g of byKey.values()) {
    out.push({
      canonicalDevice: g.canonicalDevice,
      platform: g.platform,
      arch: g.arch,
      test: g.test,
      runs: g.runs,
      chrfppCount: g.chrfppValues.length,
      chrfppMean: _meanOrNull(g.chrfppValues),
      chrfppStd: stddev(g.chrfppValues),
      cometCount: g.cometValues.length,
      cometMean: _meanOrNull(g.cometValues),
      cometStd: stddev(g.cometValues),
      tpsCount: g.tpsValues.length,
      tpsMean: _meanOrNull(g.tpsValues),
      tpsStd: stddev(g.tpsValues)
    })
  }
  return out
}

/**
 * Wrapper around `utils.mean` that returns `null` on an empty array
 * instead of 0. Downstream rendering uses null as the "no data
 * available" signal (renders as `-`) — distinct from a legitimate
 * 0 mean. We keep `utils.stddev` unchanged since it already returns
 * 0 for <2 samples, which is the correct behaviour for a deterministic
 * metric with a single observation.
 */
function _meanOrNull (values) {
  if (!values || values.length === 0) return null
  return mean(values)
}

// ---------------------------------------------------------------------------
// COMET scoring via `comet-score` CLI
// ---------------------------------------------------------------------------

/**
 * Writes three temp files and invokes `comet-score`. Returns an
 * array of COMET scores aligned 1:1 with `triples`. Returns null
 * (NOT throws) on any failure — caller renders a COMET-less report
 * and the workflow keeps going.
 *
 * Temp dir is always cleaned up via try/finally, even on CLI
 * failure / crash, so repeated weekly runs don't leak `/tmp` state.
 *
 * @param {Array<object>} triples
 * @param {string} model
 * @returns {number[] | null}
 */
function runCometScore (triples, model) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comet-nmt-'))
  try {
    const srcPath = path.join(tmp, 'src.txt')
    const mtPath = path.join(tmp, 'mt.txt')
    const refPath = path.join(tmp, 'ref.txt')

    // Single pass over triples — `comet-score` is strictly one
    // sentence per line, so we collapse internal newlines as we go
    // and open each output file once.
    const srcFd = fs.openSync(srcPath, 'w')
    const mtFd = fs.openSync(mtPath, 'w')
    const refFd = fs.openSync(refPath, 'w')
    const sanitize = s => String(s).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
    try {
      for (const t of triples) {
        fs.writeSync(srcFd, sanitize(t.src) + '\n')
        fs.writeSync(mtFd, sanitize(t.mt) + '\n')
        fs.writeSync(refFd, sanitize(t.ref) + '\n')
      }
    } finally {
      fs.closeSync(srcFd)
      fs.closeSync(mtFd)
      fs.closeSync(refFd)
    }

    console.log(`  Running comet-score on ${triples.length} triples with ${model}...`)
    const res = spawnSync('comet-score', [
      '-s', srcPath, '-t', mtPath, '-r', refPath,
      '--model', model,
      '--quiet'
    ], { encoding: 'utf-8' })

    if (res.error) {
      console.error(`  comet-score spawn failed: ${res.error.message}`)
      return null
    }
    if (res.status !== 0) {
      console.error(`  comet-score exited ${res.status}`)
      console.error(res.stderr)
      return null
    }

    // comet-score 2.2.x output: one line per MT segment, shaped as
    //   <mt-filename>\tSegment N\tscore: 0.XXXX
    // plus a final "System score: 0.XXXX" line. We capture the segment
    // index so we can place scores back by (captured) index rather than
    // by stdout line order — safer against any future reordering.
    const scores = new Array(triples.length).fill(null)
    let matched = 0
    for (const line of res.stdout.split(/\r?\n/)) {
      const m = line.match(/Segment\s+(\d+)\s+score:\s+(-?\d+(?:\.\d+)?)/)
      if (!m) continue
      const idx = parseInt(m[1], 10)
      if (idx >= 0 && idx < scores.length) {
        scores[idx] = parseFloat(m[2])
        matched++
      }
    }
    if (matched !== triples.length) {
      console.error(`  comet-score returned ${matched} scores, expected ${triples.length}`)
      console.error(`  stdout preview: ${res.stdout.slice(0, 300)}`)
      return null
    }
    return scores
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function fmtPct (v) {
  if (v === null || v === undefined) return '-'
  return (v * 100).toFixed(1) + '%'
}

function fmtComet (v) {
  if (v === null || v === undefined) return '-'
  return v.toFixed(3)
}

function fmtPctMeanStd (mean, std) {
  if (mean === null || mean === undefined) return '-'
  // Std shown in the same pp scale as the mean so "97.0% ±0.3%" is easy
  // to eyeball. Std is hidden when it would always be 0.0% (single run)
  // to reduce visual clutter, but kept for >=2 runs even if 0 because
  // "2 runs at exact 0 std" is genuinely informative.
  const meanStr = (mean * 100).toFixed(1) + '%'
  if (std === null || std === undefined) return meanStr
  return `${meanStr} ±${(std * 100).toFixed(1)}%`
}

function fmtCometMeanStd (mean, std) {
  if (mean === null || mean === undefined) return '-'
  const meanStr = mean.toFixed(3)
  if (std === null || std === undefined) return meanStr
  return `${meanStr} ±${std.toFixed(3)}`
}

// TPS (tokens/sec) is the noisiest of the three aggregated metrics —
// thermal state, warm-vs-cold GPU/Vulkan init, and cross-process CPU
// contention all move it by ±tens of percent even with identical code.
// We still render it as mean ± std for consistency with chrF++ / COMET
// because std IS the signal here (large std = flaky runner or perf
// drift). Interpret absolute values with a grain of salt and focus on
// same-cell deltas across runs.
function fmtTpsMeanStd (mean, std) {
  if (mean === null || mean === undefined) return '-'
  const digits = mean >= 100 ? 0 : 1
  const meanStr = mean.toFixed(digits)
  if (std === null || std === undefined) return `${meanStr} t/s`
  return `${meanStr} ±${std.toFixed(digits)} t/s`
}

/**
 * Renders the COMET markdown report. Pure function of (groups, meta)
 * so the unit test can exercise it offline.
 *
 * @param {Array<object>} groups - output of aggregateGroups
 * @param {object} meta
 * @param {string} meta.model
 * @param {number} meta.runs
 * @param {string} meta.generatedAt - ISO timestamp
 * @param {boolean} [meta.skipComet]
 * @param {boolean} [meta.cometFailed] - true when scoring was attempted but
 *                                       no COMET values came back for anyone
 * @returns {string} markdown
 */
function renderMarkdown (groups, meta) {
  const lines = []
  lines.push('## nmtcpp COMET Quality Report')
  lines.push(`Generated: ${meta.generatedAt} | Runs aggregated: ${meta.runs} | Model: \`${meta.model}\``)
  lines.push('')
  if (meta.skipComet) {
    lines.push('> COMET scoring skipped (`--skip-comet`). Only chrF++ is shown.')
    lines.push('')
  }
  if (meta.cometFailed && !meta.skipComet) {
    lines.push('> **COMET scoring failed for this run** — see workflow log. chrF++ column below is still valid (taken from the per-run artifacts).')
    lines.push('')
  }
  if (!groups || groups.length === 0) {
    lines.push('_No scorable triples found — every result was missing at least one of `input`, `output`, or `reference`._')
    return lines.join('\n') + '\n'
  }

  // Sort: platform ASC, then canonical device ASC, then test ASC.
  // Explicit 'en' locale keeps the row order identical across CI
  // runners regardless of their system locale.
  const sorted = [...groups].sort((a, b) => {
    const pa = a.platform || ''
    const pb = b.platform || ''
    if (pa !== pb) return pa.localeCompare(pb, 'en')
    if (a.canonicalDevice !== b.canonicalDevice) return a.canonicalDevice.localeCompare(b.canonicalDevice, 'en')
    return a.test.localeCompare(b.test, 'en')
  })

  lines.push('| Test | Device | Runs | chrF++ (mean ±std) | COMET (mean ±std) | TPS (mean ±std) |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const g of sorted) {
    lines.push(`| \`${g.test}\` | ${g.canonicalDevice} | ${g.runs} | ${fmtPctMeanStd(g.chrfppMean, g.chrfppStd)} | ${fmtCometMeanStd(g.cometMean, g.cometStd)} | ${fmtTpsMeanStd(g.tpsMean, g.tpsStd)} |`)
  }

  lines.push('')
  lines.push('### Notes')
  lines.push('- chrF++ is character + word n-gram F-score (sacrebleu-compatible). Values ~0-1 · higher is better.')
  lines.push('- COMET is a neural reference-based MT metric (Unbabel). Values ~0-1 · higher is better · 0.8+ is strong.')
  lines.push('- TPS is tokens/sec as reported by the native addon (`metrics.tps` per result). Higher is better. Unlike the quality metrics, TPS is inherently noisy (thermal state, cold-vs-warm GPU/Vulkan init, CPU contention on shared runners) — read absolute numbers loosely and watch for cell-level std / drift instead.')
  lines.push('- Quality and TPS are not on comparable calibration curves (chrF++ and COMET are surface n-gram overlap and neural semantic similarity; TPS is throughput). They are shown side by side intentionally — interpret each independently.')
  lines.push('- Rows aggregate the last N `On PR Trigger (NMTCPP)` runs by `(platform/arch or stable device name, test)`. Ephemeral hosted-runner names like `GitHub Actions 1000320663` are collapsed into `linux/x64 (hosted)` etc. so you see one row per matrix cell.')
  lines.push('- For deterministic quality metrics on a stable model, std is 0. **Non-zero quality std means the translation output changed between the aggregated runs** — i.e. a code / model / config drift landed during the aggregation window. TPS std, by contrast, is expected to be non-zero; a sudden jump in TPS std (or a drop in TPS mean) is the signal to watch for perf regressions.')
  lines.push('- Other signals to watch for: (a) absolute COMET per row (< 0.6 = suspect, < 0.5 = broken); (b) cross-platform gap on the same test (e.g. mobile IndicTrans COMET 0.51 vs desktop 0.95 → **QVAC-16488** sacremoses bundling regression); (c) TPS mean collapsing on a specific platform (e.g. `ai-run-windows11-gpu` at 0.3 t/s vs its usual 80 t/s → Vulkan cold-init flake).')
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main () {
  const args = parseArgs(process.argv)
  console.log('comet-score-nmt starting')
  console.log(`  runs=${args.runs}  workflow="${args.workflow}"  model=${args.model}  output=${args.output}${args.dir ? `  dir=${args.dir}` : ''}${args.skipComet ? '  skip-comet=true' : ''}`)

  let rootDir
  let tmpDir = null
  try {
    if (args.dir) {
      rootDir = args.dir
    } else {
      // Aggregate ALL completed runs regardless of conclusion.
      //
      // The umbrella "On PR Trigger (NMTCPP)" workflow is a big matrix
      // (desktop × {linux/x64, linux/arm64, darwin/arm64, win32-x64,
      // ubuntu-22/24} plus mobile × {iOS, Android with 2+ devices}).
      // A single leg going red (e.g. a transient Vulkan cold-init
      // flake on ai-run-windows11-gpu, an SSH glitch in the Android
      // pool) marks the whole run `conclusion=failure`, but the OTHER
      // legs' perf-report-* artifacts are still attached and valid.
      // Filtering by `success` was throwing away all the Android /
      // iOS / hosted-Linux data from those runs — which is exactly
      // what caused "no Android rows" after the last refactor.
      //
      // Truly broken runs (pre-test infra failure, GitHub API
      // outage) attach zero perf-report-* artifacts, so they
      // contribute nothing to the aggregate naturally —
      // collectReportsFromDir just doesn't find any JSON to parse.
      // No artificial filter needed.
      const runs = listWorkflowRuns(args.workflow, args.runs, args.repo)
      if (!runs.length) {
        console.error('No completed runs found — cannot score.')
        // Still emit a stub markdown so the workflow's Step Summary writer has something sane.
        writeOutput(args.output, renderMarkdown([], {
          model: args.model, runs: args.runs, generatedAt: new Date().toISOString()
        }))
        process.exit(0)
      }
      console.log(`  Found ${runs.length} completed runs. Downloading perf-report artifacts (parallel, concurrency=${DEFAULT_DOWNLOAD_CONCURRENCY})...`)
      for (const r of runs) console.log(`    #${r.number} (${r.databaseId})`)
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comet-nmt-src-'))
      await downloadRunArtifactsParallel(runs, tmpDir, 'perf-report-*', args.repo,
        { concurrency: DEFAULT_DOWNLOAD_CONCURRENCY })
      rootDir = tmpDir
    }

    const reports = collectReportsFromDir(rootDir)
    console.log(`  Collected ${reports.length} perf-report.json file(s)`)
    const triples = extractTriples(reports)
    console.log(`  Extracted ${triples.length} triples with input+output+reference`)

    let scores = null
    if (!args.skipComet && triples.length > 0) {
      scores = runCometScore(triples, args.model)
    }

    const groups = aggregateGroups(triples, scores)
    console.log(`  Aggregated into ${groups.length} groups by (canonicalDevice, test)`)

    const md = renderMarkdown(groups, {
      model: args.model,
      runs: args.runs,
      generatedAt: new Date().toISOString(),
      skipComet: args.skipComet,
      cometFailed: !args.skipComet && triples.length > 0 && scores === null
    })
    writeOutput(args.output, md)
    console.log(`  Wrote ${args.output} (${md.length} chars, ${groups.length} groups from ${triples.length} triples${scores ? `, ${scores.length} COMET scores` : ''})`)
  } finally {
    // Hygiene: clean up our own tmp dir but only when we own it.
    // The `try/finally` guarantees we clean up even when main()
    // throws (previously this code was unreachable on error).
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    }
  }
}

function writeOutput (outPath, md) {
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, md)
  } catch (err) {
    console.error(`  failed to write ${outPath}: ${err.message}`)
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(`comet-score-nmt crashed: ${err.stack || err.message}`)
    // NEVER fail the workflow from here — chrF++ path must still ship.
  }).finally(() => {
    process.exit(0)
  })
} else {
  module.exports = {
    parseArgs,
    canonicalDeviceLabel,
    extractTriples,
    aggregateGroups,
    renderMarkdown,
    fmtPct,
    fmtComet,
    fmtPctMeanStd,
    fmtCometMeanStd,
    fmtTpsMeanStd,
    // Re-exported for the unit test so it doesn't have to reach into
    // ./gh-artifacts directly.
    collectReportsFromDir
  }
}
