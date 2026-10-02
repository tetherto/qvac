#!/usr/bin/env node
'use strict'
// Writes run-meta/run-meta.json for benchmark-perf-llm-llamacpp.yml: the addon
// version this run benchmarks and the coverage targets its report is scored
// against. The summarize job reads both back, so a re-render always reflects
// what THAT run targeted rather than the renderer's current matrix.
//
// A real file rather than an inline `node -e "..."`: inside a double-quoted
// shell string, a double quote in a code comment ends the string, node runs
// the truncated script, writes nothing, and the step fails on the next line
// with no error from node at all. That shipped here once.
//
// Reads SWEEP_PARAMS and RUN_MOBILE. Writes to run-meta/ under the working
// directory (override with RUN_META_DIR).

const fs = require('fs')
const path = require('path')

const pkgDir = path.resolve(__dirname, '..', '..', 'packages', 'llm-llamacpp')

function runMeta({ sweepParams, wantsMobile }) {
  // eslint-disable-next-line global-require -- resolved relative to the repo root at call time
  const pkg = require(path.join(pkgDir, 'package.json'))
  // eslint-disable-next-line global-require
  const m = require(path.join(pkgDir, 'test', 'integration', '_benchmark-matrix.js'))
  const selected = m.parseSweepParams(sweepParams)

  // Stamp the shards THIS dispatch selected, not the whole matrix. Coverage
  // is scored against this list, so stamping all 86 on a load-mode-only run
  // would report 74 phantom gaps for cases the dispatch did not select.
  //
  // expectedShards is the MOBILE coverage target. A desktop-only dispatch
  // requests none, so stamping the planned mobile shards there would report
  // coverage missing for a leg that never ran.
  const planned = new Set(
    wantsMobile ? m.planMobileBatches(selected).flatMap((b) => b.groups.map((g) => g.grep)) : []
  )
  const expectedShards = m
    .matrix()
    .filter((cell) => planned.has(m.runFunctionName(cell)))
    .map(m.mobileShardKey)

  // The load modes this dispatch asked for, independent of mobile.
  // expectedShards is [] on a desktop-only run; scoring the desktop legs
  // against that reported every absent mode as not selected and suppressed
  // the coverage warning.
  const lm = selected && selected.get('load-mode')
  const selectedLoadModes =
    !selected || !selected.has('load-mode') || lm === null ? m.LOAD_MODES.slice() : lm.slice()

  return {
    addonVersion: '@qvac/llm-llamacpp@' + pkg.version,
    sweepParams,
    expectedShards,
    selectedLoadModes
  }
}

function main() {
  const meta = runMeta({
    sweepParams: (process.env.SWEEP_PARAMS || '').trim(),
    wantsMobile: process.env.RUN_MOBILE === 'true'
  })
  const dir = path.resolve(process.env.RUN_META_DIR || 'run-meta')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'run-meta.json'), JSON.stringify(meta) + '\n')
}

if (require.main === module) main()

module.exports = { runMeta }
