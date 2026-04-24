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
 *   1. Mirror aggregate.js and pull the last N completed runs of
 *      "Integration Tests (NMTCPP)" via `gh run list` + `gh run
 *      download`, giving us each run's `performance-report.json`(s).
 *   2. Walk those reports, collect (test, device, input, output,
 *      reference, chrfpp) triples. Deduplicate on (device, test) —
 *      the last-seen wins so the most recent run's numbers show up.
 *   3. Write one row per triple into /tmp/{src,mt,ref}.txt in the
 *      exact 1-line-per-sentence shape unbabel-comet's `comet-score`
 *      CLI expects.
 *   4. Shell out to `comet-score -s … -t … -r … --model …`, parse the
 *      per-sentence scores, merge them back onto the triples.
 *   5. Render reports/nmtcpp-comet.md with a single
 *      `Test | Device | chrF++ | COMET | Δ vs chrF++` table.
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
 *   --runs N       last N completed "Integration Tests (NMTCPP)" runs
 *                  to harvest. Defaults to 6 (matches aggregate.js).
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
const { execSync, spawnSync } = require('child_process')

// `On PR Trigger (NMTCPP)` is the umbrella workflow that actually runs
// per-PR integration tests (including the one that emits perf-report-*
// artifacts). The inner `Integration Tests (NMTCPP)` is invoked via
// `workflow_call` and its artifacts surface under the umbrella run,
// not the inner one — so we query the umbrella by default.
const DEFAULT_WORKFLOW = 'On PR Trigger (NMTCPP)'
const DEFAULT_RUNS = 6
const DEFAULT_MODEL = 'Unbabel/wmt22-comet-da'
const DEFAULT_OUTPUT = 'reports/nmtcpp-comet.md'

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

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
      case '--runs': args.runs = parseInt(argv[++i], 10) || DEFAULT_RUNS; break
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
// gh CLI helpers (mirrors aggregate.js's shape)
// ---------------------------------------------------------------------------

function ghExec (cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    console.error(`gh command failed: ${cmd}`)
    console.error((err.stderr || err.message || '').toString())
    return ''
  }
}

function listWorkflowRuns (workflow, count, repo) {
  const repoFlag = repo ? ` -R ${repo}` : ''
  const json = ghExec(
    `gh run list --workflow "${workflow}" --status completed --limit ${count} --json databaseId,displayTitle,conclusion,number${repoFlag}`
  )
  if (!json) return []
  try { return JSON.parse(json) } catch (_) { return [] }
}

function downloadRunArtifacts (runId, destDir, repo) {
  const repoFlag = repo ? ` -R ${repo}` : ''
  const runDir = path.join(destDir, String(runId))
  fs.mkdirSync(runDir, { recursive: true })
  ghExec(`gh run download ${runId} -D "${runDir}" -p "perf-report-*"${repoFlag}`)
  return runDir
}

// ---------------------------------------------------------------------------
// Triple extraction
// ---------------------------------------------------------------------------

/**
 * Walks `rootDir` for every `performance-report.json`, validates
 * schema minimally, returns flat array of raw reports.
 *
 * @param {string} rootDir
 * @returns {Array<object>}
 */
function collectReports (rootDir) {
  const out = []
  function walk (d) {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name === 'performance-report.json') {
        try {
          const data = JSON.parse(fs.readFileSync(full, 'utf-8'))
          if (data && Array.isArray(data.results)) out.push(data)
        } catch (err) {
          console.error(`  skipping ${full}: ${err.message}`)
        }
      }
    }
  }
  walk(rootDir)
  return out
}

/**
 * Converts an array of perf reports into a de-duplicated array of
 * scoring triples. Dedup key is `${deviceName}|${test}` and the
 * last-seen report wins — which means if the same test ran in
 * multiple recent builds, we score the most recently-downloaded one
 * (gh run list returns most-recent-first).
 *
 * A triple is only emitted if it has non-empty `input`, `output`,
 * AND `reference` — COMET's reference-based model can't score
 * incomplete triples.
 *
 * @param {Array<object>} reports
 * @returns {Array<object>} triples with shape
 *   { test, device, platform, src, mt, ref, chrfpp }
 */
function extractTriples (reports) {
  const byKey = new Map()
  for (const report of reports) {
    const dev = (report.device && report.device.name) || 'unknown'
    const platform = (report.device && report.device.platform) || ''
    for (const r of report.results || []) {
      const src = (r.input || '').trim()
      const mt = (r.output || '').trim()
      const ref = (r.reference || (r.quality && r.quality.reference) || '').trim()
      if (!src || !mt || !ref) continue
      const key = `${dev}|${r.test}`
      byKey.set(key, {
        test: r.test,
        device: dev,
        platform,
        src,
        mt,
        ref,
        chrfpp: (r.metrics && typeof r.metrics.chrfpp === 'number') ? r.metrics.chrfpp : null
      })
    }
  }
  return Array.from(byKey.values())
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
 * @param {Array<object>} triples
 * @param {string} model
 * @returns {number[] | null}
 */
function runCometScore (triples, model) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comet-nmt-'))
  const srcPath = path.join(tmp, 'src.txt')
  const mtPath = path.join(tmp, 'mt.txt')
  const refPath = path.join(tmp, 'ref.txt')

  // comet-score is strictly one sentence per line — collapse internal
  // newlines so we never desync with the triple index.
  const sanitize = s => String(s).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  fs.writeFileSync(srcPath, triples.map(t => sanitize(t.src)).join('\n') + '\n')
  fs.writeFileSync(mtPath, triples.map(t => sanitize(t.mt)).join('\n') + '\n')
  fs.writeFileSync(refPath, triples.map(t => sanitize(t.ref)).join('\n') + '\n')

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

/**
 * Renders the COMET markdown report. Pure function of (triples,
 * cometScores, meta) so the unit test can exercise it offline.
 *
 * @param {Array<object>} triples
 * @param {number[] | null} cometScores - null when COMET was skipped
 * @param {object} meta
 * @param {string} meta.model
 * @param {number} meta.runs
 * @param {string} meta.generatedAt - ISO timestamp
 * @param {boolean} [meta.skipComet]
 * @returns {string} markdown
 */
function renderMarkdown (triples, cometScores, meta) {
  const lines = []
  lines.push('## nmtcpp COMET Quality Report')
  lines.push(`Generated: ${meta.generatedAt} | Runs aggregated: ${meta.runs} | Model: \`${meta.model}\``)
  lines.push('')
  if (meta.skipComet) {
    lines.push('> COMET scoring skipped (`--skip-comet`). Only chrF++ is shown.')
    lines.push('')
  }
  if (cometScores === null && !meta.skipComet) {
    lines.push('> **COMET scoring failed for this run** — see workflow log. chrF++ column below is still valid (taken from the per-run artifacts).')
    lines.push('')
  }
  if (triples.length === 0) {
    lines.push('_No scorable triples found — every result was missing at least one of `input`, `output`, or `reference`._')
    return lines.join('\n') + '\n'
  }

  // Sort: platform ASC, then device ASC, then test base ASC, then CPU before GPU
  const sorted = [...triples].sort((a, b) => {
    if (a.platform !== b.platform) return a.platform.localeCompare(b.platform)
    if (a.device !== b.device) return a.device.localeCompare(b.device)
    return a.test.localeCompare(b.test)
  })

  lines.push('| Test | Device | chrF++ | COMET |')
  lines.push('| --- | --- | --- | --- |')
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]
    // Align index back to the scores list: the scores were computed
    // on the un-sorted triples array, so look up by identity.
    const originalIdx = triples.indexOf(t)
    const cometVal = (cometScores && originalIdx >= 0) ? cometScores[originalIdx] : null
    lines.push(`| \`${t.test}\` | ${t.device} | ${fmtPct(t.chrfpp)} | ${fmtComet(cometVal)} |`)
  }

  lines.push('')
  lines.push('### Notes')
  lines.push('- chrF++ is character + word n-gram F-score (sacrebleu-compatible). Values ~0-1 · higher is better.')
  lines.push('- COMET is a neural reference-based MT metric (Unbabel). Values ~0-1 · higher is better · 0.8+ is strong.')
  lines.push('- The two metrics are not on the same calibration curve (chrF++ is surface n-gram overlap; COMET is neural semantic similarity calibrated to human direct-assessment). They are shown side by side intentionally — interpret each independently, not as a subtraction.')
  lines.push('- What to watch for: (a) the **absolute COMET** value per row (< 0.6 = suspect, < 0.5 = broken); (b) cross-platform deltas on the **same test** (e.g. mobile IndicTrans COMET 0.51 vs desktop 0.95 → signal of the sacremoses bundling regression tracked as **QVAC-16488**).')
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main () {
  const args = parseArgs(process.argv)
  console.log('comet-score-nmt starting')
  console.log(`  runs=${args.runs}  workflow="${args.workflow}"  model=${args.model}  output=${args.output}${args.dir ? `  dir=${args.dir}` : ''}${args.skipComet ? '  skip-comet=true' : ''}`)

  let rootDir
  let tmpDir = null
  if (args.dir) {
    rootDir = args.dir
  } else {
    const runs = listWorkflowRuns(args.workflow, args.runs, args.repo)
    if (!runs.length) {
      console.error('No completed runs found — cannot score.')
      // Still emit a stub markdown so the workflow's Step Summary writer has something sane.
      writeOutput(args.output, renderMarkdown([], null, {
        model: args.model, runs: args.runs, generatedAt: new Date().toISOString()
      }))
      process.exit(0)
    }
    console.log(`  Found ${runs.length} runs. Downloading perf-report artifacts...`)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comet-nmt-src-'))
    for (const r of runs) {
      console.log(`    #${r.number} (${r.databaseId})`)
      downloadRunArtifacts(r.databaseId, tmpDir, args.repo)
    }
    rootDir = tmpDir
  }

  const reports = collectReports(rootDir)
  console.log(`  Collected ${reports.length} perf-report.json file(s)`)
  const triples = extractTriples(reports)
  console.log(`  Extracted ${triples.length} unique {device,test} triples with input+output+reference`)

  let scores = null
  if (!args.skipComet && triples.length > 0) {
    scores = runCometScore(triples, args.model)
  }

  const md = renderMarkdown(triples, scores, {
    model: args.model,
    runs: args.runs,
    generatedAt: new Date().toISOString(),
    skipComet: args.skipComet
  })
  writeOutput(args.output, md)
  console.log(`  Wrote ${args.output} (${md.length} chars, ${triples.length} rows${scores ? `, ${scores.length} COMET scores` : ''})`)

  // Hygiene: clean up our own tmp dir but only when we own it.
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
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
  try {
    main()
  } catch (err) {
    console.error(`comet-score-nmt crashed: ${err.stack || err.message}`)
    // NEVER fail the workflow from here — chrF++ path must still ship.
  }
  process.exit(0)
} else {
  module.exports = {
    collectReports,
    extractTriples,
    renderMarkdown,
    fmtPct,
    fmtComet
  }
}
