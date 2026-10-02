#!/usr/bin/env node
'use strict'

// Resolves the `sweep_params` selector for benchmark-perf-llm-llamacpp.yml,
// using the canonical parser in _benchmark-matrix.js rather than a
// reimplementation — one selector, one set of rules, no drift.
//
// A real file rather than an inline `node -e`: a script embedded in a
// multi-line `run:` block is opaque to YAML validation and to every local
// check, so a malformed one only surfaces when the workflow runs. That is
// exactly how an unterminated heredoc previously shipped here.
//
// Reads SWEEP_PARAMS and RUN_MOBILE; writes the selection outputs for
// $GITHUB_OUTPUT. Throws — failing the run in ~30s, before the prebuild — on
// an unknown param, an invalid value, an axis that cannot narrow a shard, or
// a selection matching no case at all.

const path = require('path')

const matrixPath = path.resolve(
  __dirname,
  '..',
  '..',
  'packages',
  'llm-llamacpp',
  'test',
  'integration',
  '_benchmark-matrix.js'
)

function resolve (raw, wantsMobile) {
  // eslint-disable-next-line global-require -- resolved relative to the repo root at call time
  const m = require(matrixPath)
  const selected = m.parseSweepParams(raw)
  const runs = m.sweepSelection(selected)
  // Planning is the validation: it throws when the selection names an axis a
  // shard runs internally, or matches no canonical case. Only meaningful when
  // mobile is actually being dispatched.
  if (wantsMobile) m.planMobileBatches(selected)
  return {
    sweep_params: raw,
    run_grid: String(runs.grid),
    run_load_mode: String(runs.loadMode),
    run_batch: String(runs.batchSweep)
  }
}

function main () {
  const raw = (process.env.SWEEP_PARAMS || '').trim()
  let outputs
  try {
    outputs = resolve(raw, process.env.RUN_MOBILE === 'true')
  } catch (err) {
    // A stack trace helps nobody reading a dispatch failure; the message
    // already names the bad axis or value and what is allowed. Printed to
    // stderr so it cannot land in $GITHUB_OUTPUT.
    process.stderr.write(`\nInvalid sweep_params ${JSON.stringify(raw)}:\n  ${err.message}\n\n`)
    process.exit(1)
  }
  process.stdout.write(
    Object.entries(outputs)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n'
  )
}

if (require.main === module) main()

module.exports = { resolve }
