#!/usr/bin/env node
'use strict'

// Plans the mobile Device Farm matrix for benchmark-perf-llm-llamacpp.yml.
//
// Run from packages/llm-llamacpp. Reads SWEEP_PARAMS; writes a
// `mobile_matrix=<json>` line for $GITHUB_OUTPUT and a human-readable summary
// to stderr.
//
// A real file rather than an inline `node -e`, for the same reason as its
// siblings here: a script inside a multi-line `run:` block is opaque to YAML
// validation and to every local check.

const m = require('../../packages/llm-llamacpp/test/integration/_benchmark-matrix.js')

function plan (raw) {
  const selected = m.parseSweepParams(raw)
  // `groups` is a STRING input on the reusable mobile workflow, so each entry
  // serialises its own group list.
  return m.planMobileBatches(selected).map((b) => ({
    cache: b.cache,
    groups: JSON.stringify(b.groups)
  }))
}

function main () {
  const raw = (process.env.SWEEP_PARAMS || '').trim()
  let batches
  try {
    batches = plan(raw)
  } catch (err) {
    process.stderr.write(`\nCannot plan the mobile matrix for ${JSON.stringify(raw)}:\n  ${err.message}\n\n`)
    process.exit(1)
  }
  const shards = batches.reduce((n, b) => n + JSON.parse(b.groups).length, 0)
  process.stderr.write(`planned ${batches.length} batches, ${shards} shards\n`)
  for (const b of batches) {
    process.stderr.write(`  ${b.cache}: ${JSON.parse(b.groups).length}\n`)
  }
  process.stdout.write('mobile_matrix=' + JSON.stringify(batches) + '\n')
}

if (require.main === module) main()

module.exports = { plan }
