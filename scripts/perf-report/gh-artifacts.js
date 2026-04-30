'use strict'

/**
 * Shared `gh`-CLI helpers for perf-report scripts.
 *
 * Previously duplicated (with slightly different signatures) across
 * `aggregate.js` and `comet-score-nmt.js`. Centralised here so:
 *
 *   - There is a single canonical signature for each helper.
 *   - Argument passing is via argv arrays to `spawnSync` — never via
 *     shell-interpolated strings — which removes an entire class of
 *     command-injection vectors around untrusted `repo`, `workflow`,
 *     `runId`, and `artifactPattern` values.
 *   - Bounded-concurrency downloads are available for callers that
 *     need to harvest many runs (the weekly COMET aggregate pulls 6+).
 *
 * No `gh` flags are constructed as a pre-joined shell string; every
 * argument is passed as a discrete element of the argv array, so
 * shell metacharacters in user input are never interpreted as shell
 * syntax.
 *
 * This module has no side effects at require-time.
 */

const fs = require('fs')
const path = require('path')
const { spawnSync, spawn } = require('child_process')

// ---------------------------------------------------------------------------
// Low-level gh invocation
// ---------------------------------------------------------------------------

/**
 * Runs `gh` with the given argv and returns trimmed stdout.
 * Returns '' on non-zero exit or missing binary — callers decide how
 * to treat the empty response. Errors are logged to stderr.
 *
 * @param {string[]} argv - arguments to pass to `gh` (do NOT prefix with "gh")
 * @returns {string} trimmed stdout, or '' on error
 */
function ghExec (argv) {
  const res = spawnSync('gh', argv, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
  if (res.error) {
    console.error(`gh exec error: ${res.error.message}`)
    return ''
  }
  if (res.status !== 0) {
    console.error(`gh exited ${res.status} for: gh ${argv.join(' ')}`)
    if (res.stderr) console.error(res.stderr.toString().trim())
    return ''
  }
  return (res.stdout || '').toString().trim()
}

// ---------------------------------------------------------------------------
// Workflow run listing
// ---------------------------------------------------------------------------

/**
 * Lists recent runs of a workflow, newest first.
 *
 * @param {string} workflow - exact workflow name (e.g. "Integration Tests (NMTCPP)")
 * @param {number} count - max runs to return
 * @param {string|null} repo - optional "owner/repo" override
 * @param {object} [opts]
 * @param {boolean} [opts.onlySuccess=false] - if true, filter to
 *        runs where `conclusion === "success"`. Default false to
 *        preserve aggregate.js's historical behaviour. Callers that
 *        need clean samples (e.g. the COMET aggregator) should
 *        enable this because failed runs often have partial or
 *        missing perf-report artifacts.
 * @returns {Array<object>} parsed `gh run list` JSON, or []
 */
function listWorkflowRuns (workflow, count, repo, opts) {
  const argv = [
    'run', 'list',
    '--workflow', workflow,
    '--status', 'completed',
    '--limit', String(count),
    '--json', 'databaseId,displayTitle,conclusion,number'
  ]
  if (repo) argv.push('-R', repo)

  const json = ghExec(argv)
  if (!json) return []
  let runs
  try { runs = JSON.parse(json) } catch (_) { return [] }
  if (opts && opts.onlySuccess) {
    runs = runs.filter(r => r && r.conclusion === 'success')
  }
  return runs
}

// ---------------------------------------------------------------------------
// Artifact download
// ---------------------------------------------------------------------------

/**
 * Downloads all (or pattern-matched) artifacts for a single run into
 * `${destDir}/${runId}`, returning that path.
 *
 * @param {string|number} runId
 * @param {string} destDir - staging root
 * @param {string|null} artifactPattern - optional `gh run download -p` glob
 * @param {string|null} repo - optional "owner/repo" override
 * @returns {string} full path to the per-run directory that was populated
 */
function downloadRunArtifacts (runId, destDir, artifactPattern, repo) {
  const runDir = path.join(destDir, String(runId))
  fs.mkdirSync(runDir, { recursive: true })
  const argv = ['run', 'download', String(runId), '-D', runDir]
  if (artifactPattern) argv.push('-p', artifactPattern)
  if (repo) argv.push('-R', repo)
  ghExec(argv)
  return runDir
}

/**
 * Parallel variant of `downloadRunArtifacts` with bounded concurrency.
 * Uses `spawn` so we don't block a CPU-bound sync loop on what is
 * essentially 6+ independent HTTP transfers. Defaults to 3
 * concurrent downloads — higher risks rate-limiting against the
 * GitHub API, lower doesn't meaningfully speed things up.
 *
 * Errors on individual downloads are logged but never reject the
 * top-level promise — the caller just sees a partial dataset, which
 * is the same failure mode as the serial version.
 *
 * @param {Array<{databaseId: string|number}>} runs
 * @param {string} destDir
 * @param {string|null} artifactPattern
 * @param {string|null} repo
 * @param {object} [opts]
 * @param {number} [opts.concurrency=3]
 * @returns {Promise<void>}
 */
async function downloadRunArtifactsParallel (runs, destDir, artifactPattern, repo, opts) {
  const concurrency = Math.max(1, (opts && opts.concurrency) || 3)
  let idx = 0
  async function worker () {
    while (true) {
      const myIdx = idx++
      if (myIdx >= runs.length) return
      const run = runs[myIdx]
      const runDir = path.join(destDir, String(run.databaseId))
      fs.mkdirSync(runDir, { recursive: true })
      const argv = ['run', 'download', String(run.databaseId), '-D', runDir]
      if (artifactPattern) argv.push('-p', artifactPattern)
      if (repo) argv.push('-R', repo)
      await new Promise(resolve => {
        const child = spawn('gh', argv, { stdio: ['ignore', 'ignore', 'pipe'] })
        let err = ''
        child.stderr.on('data', d => { err += d.toString() })
        child.on('error', e => {
          console.error(`  run #${run.number || run.databaseId}: spawn error: ${e.message}`)
          resolve()
        })
        child.on('close', code => {
          if (code !== 0) {
            console.error(`  run #${run.number || run.databaseId}: gh exit ${code}`)
            if (err) console.error(`    ${err.trim()}`)
          }
          resolve()
        })
      })
    }
  }
  const workers = []
  for (let i = 0; i < concurrency; i++) workers.push(worker())
  await Promise.all(workers)
}

// ---------------------------------------------------------------------------
// Filesystem collection
// ---------------------------------------------------------------------------

/**
 * Recursively walks `dir` and returns an array of parsed
 * `performance-report.json` objects. Invalid JSON files are skipped
 * with a log line rather than throwing.
 *
 * @param {string} dir
 * @returns {Array<object>}
 */
function collectReportsFromDir (dir) {
  const reports = []
  function walk (d) {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return }
    for (const entry of entries) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name === 'performance-report.json') {
        try {
          const data = JSON.parse(fs.readFileSync(full, 'utf-8'))
          reports.push(data)
        } catch (err) {
          console.error(`  skipping ${full}: ${err.message}`)
        }
      }
    }
  }
  walk(dir)
  return reports
}

module.exports = {
  ghExec,
  listWorkflowRuns,
  downloadRunArtifacts,
  downloadRunArtifactsParallel,
  collectReportsFromDir
}
