'use strict'

// Generates the mobile perf benchmark shard files from the single source of
// truth, test/integration/_benchmark-matrix.js. The shard files are NOT
// committed (see .gitignore) — they are regenerated wherever the benchmark is
// built or run, so the matrix is the only place the 2 x 5 x 7 grid is defined.
//
//   node scripts/generate-benchmark-shards.js            # (re)write shards + prune orphans
//   node scripts/generate-benchmark-shards.js --check     # verify committed artifacts vs matrix
//   node scripts/generate-benchmark-shards.js --assert-shards  # fail unless every shard exists on disk
//   node scripts/generate-benchmark-shards.js --groups    # print workflow test_groups JSON
//
// --check needs no shard files on disk: it verifies the committed workflow
// test_groups and the committed integration.auto.cjs references both match the
// matrix. --assert-shards is the hard pre-bundle gate: it makes it impossible
// to build the Device Farm bundle without all shards present.

const fs = require('fs')
const path = require('path')
const {
  matrix,
  shardFileName,
  runFunctionName,
  shardContents,
  workflowBatches,
  MAX_SHARDS_PER_BATCH
} = require('../test/integration/_benchmark-matrix.js')

const integrationDir = path.resolve(__dirname, '..', 'test', 'integration')
const mobileAutoFile = path.resolve(__dirname, '..', 'test', 'mobile', 'integration.auto.cjs')
const workflowFile = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'benchmark-perf-llm-llamacpp.yml'
)

const mode = process.argv.includes('--check')
  ? 'check'
  : process.argv.includes('--assert-shards')
    ? 'assert'
    : process.argv.includes('--groups')
      ? 'groups'
      : 'write'

const SHARD_PREFIX = 'benchmark-perf-'

// Verify the mobile PLAN, which is what the workflow now consumes.
//
// The workflow used to hold each batch as literal JSON and this compared the
// two texts. It no longer does: the mobile matrix is planned at run time from
// the canonical matrix so `sweep_params` can reduce it, and there is no YAML
// literal left to drift. What has to hold instead is that the planner only
// ever emits real, runnable, in-budget batches.
function checkGroups() {
  const plan = workflowBatches()
  let bad = 0

  // No batch may exceed the proven in-budget Device Farm load. Above it
  // Android serializes past its time budget and the macOS runner fills its
  // disk collecting iOS logs, so an oversized batch fails here rather than
  // being discovered on Device Farm an hour in. The load-mode axis is 12
  // cells and had to be split into two batches for exactly this reason.
  for (const batch of plan) {
    if (batch.groups.length > MAX_SHARDS_PER_BATCH) {
      console.error(
        `MISMATCH: batch "${batch.cache}" has ${batch.groups.length} shards, ` +
          `over the proven safe limit of ${MAX_SHARDS_PER_BATCH}`
      )
      bad++
    }
    if (batch.groups.length === 0) {
      console.error(`MISMATCH: batch "${batch.cache}" is empty`)
      bad++
    }
  }

  // Every planned shard must be a case the matrix defines, so the planner can
  // only ever select from the canonical catalogue and never invent a runner
  // name that no generated test answers to.
  const canonical = new Set(matrix().map((cell) => runFunctionName(cell)))
  const planned = new Set()
  for (const batch of plan) {
    for (const group of batch.groups) {
      if (!canonical.has(group.grep)) {
        console.error(`MISMATCH: planned shard ${group.grep} is not in the matrix`)
        bad++
      }
      if (planned.has(group.grep)) {
        console.error(`MISMATCH: shard ${group.grep} planned into more than one batch`)
        bad++
      }
      planned.add(group.grep)
    }
  }

  // An unselected plan must cover the whole catalogue, so the default
  // dispatch still runs everything it used to.
  if (planned.size !== canonical.size) {
    console.error(
      `MISMATCH: unselected plan covers ${planned.size} shards, matrix defines ${canonical.size}`
    )
    bad++
  }

  return bad
}

// Verify the committed integration.auto.cjs is in lockstep with the matrix on
// BOTH axes the benchmark depends on:
//  - the shard files it loads (runIntegrationModule('../integration/<file>'))
//  - the run-function NAMES it defines, which the workflow test_groups grep
//    against. Those names come from toFunctionName in
//    generate-mobile-integration-tests.js; matching them here (rather than the
//    matrix's runFunctionName matching a convention) means a change to that
//    generator that desyncs the grep fails the gate instead of silently
//    running 0 tests.
function bidiDiff(label, expected, actual) {
  let bad = 0
  for (const v of expected) {
    if (!actual.has(v)) {
      bad++
      console.error(`MISMATCH: integration.auto.cjs missing ${label} ${v}`)
    }
  }
  for (const v of actual) {
    if (!expected.has(v)) {
      bad++
      console.error(`MISMATCH: integration.auto.cjs has stale ${label} ${v}`)
    }
  }
  return bad
}

function checkMobileAuto() {
  if (!fs.existsSync(mobileAutoFile)) {
    console.error(
      `MISMATCH: integration.auto.cjs not found at ${mobileAutoFile}. Run: npm run test:mobile:generate`
    )
    return 1
  }
  const content = fs.readFileSync(mobileAutoFile, 'utf8')
  const cells = matrix()

  const referencedFiles = new Set(
    [...content.matchAll(/runIntegrationModule\('\.\.\/integration\/([^']+)'/g)]
      .map((m) => m[1])
      .filter((f) => f.startsWith(SHARD_PREFIX))
  )
  const definedFns = new Set(
    [...content.matchAll(/function\s+(run\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((n) => n.startsWith('runBenchmarkPerf'))
  )

  return (
    bidiDiff('shard', new Set(cells.map(shardFileName)), referencedFiles) +
    bidiDiff('run-function', new Set(cells.map(runFunctionName)), definedFns)
  )
}

// Hard gate: every matrix shard file must exist on disk (so the bundle that
// goes to Device Farm contains them). Makes it impossible to run the benchmark
// without shards.
function assertShards() {
  let missing = 0
  for (const cell of matrix()) {
    if (!fs.existsSync(path.join(integrationDir, shardFileName(cell)))) {
      missing++
      console.error(`MISSING shard: ${shardFileName(cell)}`)
    }
  }
  return missing
}

// Write every matrix shard, then prune any benchmark-perf-*.test.js the matrix
// no longer produces, so shrinking the matrix never leaves orphans behind.
function writeShards() {
  const expected = new Set(matrix().map(shardFileName))
  let written = 0
  for (const cell of matrix()) {
    fs.writeFileSync(path.join(integrationDir, shardFileName(cell)), shardContents(cell))
    written++
  }
  let pruned = 0
  for (const entry of fs.readdirSync(integrationDir)) {
    if (entry.startsWith(SHARD_PREFIX) && entry.endsWith('.test.js') && !expected.has(entry)) {
      fs.unlinkSync(path.join(integrationDir, entry))
      pruned++
    }
  }
  console.log(
    `Wrote ${written} shard files from the matrix${pruned ? `, pruned ${pruned} orphan(s)` : ''}.`
  )
}

if (mode === 'groups') {
  for (const batch of workflowBatches()) {
    console.log(`# cache: ${batch.cache}`)
    console.log(JSON.stringify(batch.groups))
  }
} else if (mode === 'check') {
  const bad = checkGroups() + checkMobileAuto()
  if (bad) {
    console.error('\nCommitted benchmark artifacts are out of sync with _benchmark-matrix.js.')
    console.error(
      'Run: npm run generate:benchmark-shards && npm run test:mobile:generate, then commit integration.auto.cjs + the workflow groups.'
    )
    process.exit(1)
  }
  console.log(
    `OK: workflow test_groups and integration.auto.cjs both match the matrix (${matrix().length} shards).`
  )
} else if (mode === 'assert') {
  const missing = assertShards()
  if (missing) {
    console.error(`\n${missing} shard file(s) missing. Run: npm run generate:benchmark-shards`)
    process.exit(1)
  }
  console.log(`OK: all ${matrix().length} shard files present on disk.`)
} else {
  writeShards()
}
