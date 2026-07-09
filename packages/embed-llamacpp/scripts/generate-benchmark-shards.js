'use strict'

// Generates the mobile perf benchmark shard files from the single source of
// truth, test/integration/_benchmark-matrix.js. The shard files are NOT
// committed (see .gitignore) — they are regenerated wherever the benchmark is
// built or run, so the (model x quant) matrix is the only place the cells are
// defined.
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
  workflowBatches
} = require('../test/integration/_benchmark-matrix.js')

const integrationDir = path.resolve(__dirname, '..', 'test', 'integration')
const mobileAutoFile = path.resolve(__dirname, '..', 'test', 'mobile', 'integration.auto.cjs')
const workflowFile = path.resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'benchmark-perf-embed-llamacpp.yml')
const manifestFile = path.resolve(__dirname, '..', 'benchmarks', 'performance', 'models.manifest.json')

const mode = process.argv.includes('--check')
  ? 'check'
  : process.argv.includes('--assert-shards')
    ? 'assert'
    : process.argv.includes('--groups')
      ? 'groups'
      : 'write'

const SHARD_PREFIX = 'benchmark-perf-'

// Verify the committed workflow test_groups match the matrix-derived batches.
function checkGroups () {
  if (!fs.existsSync(workflowFile)) {
    console.error(`MISMATCH: benchmark workflow not found at ${workflowFile}`)
    return 1
  }
  const yaml = fs.readFileSync(workflowFile, 'utf8')
  // Parse each committed groups value and compare canonically, so reformatting
  // the inline JSON (extra whitespace etc.) doesn't trip a false mismatch.
  const committed = [...yaml.matchAll(/groups:\s*'(.+)'/g)].map((m) => {
    try { return JSON.stringify(JSON.parse(m[1])) } catch { return m[1] }
  })
  const expected = workflowBatches().map((b) => JSON.stringify(b.groups))
  let bad = 0
  if (committed.length !== expected.length) {
    console.error(`MISMATCH: workflow has ${committed.length} group batches, matrix yields ${expected.length}`)
    bad++
  }
  for (let i = 0; i < expected.length; i++) {
    if (committed[i] !== expected[i]) {
      bad++
      console.error(`MISMATCH: workflow group batch ${i} differs from matrix`)
    }
  }
  return bad
}

// Drift guard: the matrix cells in _benchmark-matrix.js are hardcoded (so the
// mobile bundler need not reach into benchmarks/performance), so assert they
// still mirror models.manifest.json, read here under Node with fs. Compares the
// (model, quant, repo, revision) cells the manifest yields against matrix().
function checkManifest () {
  if (!fs.existsSync(manifestFile)) {
    console.error(`MISMATCH: benchmark manifest not found at ${manifestFile}`)
    return 1
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const fromManifest = []
  for (const model of (manifest.models || [])) {
    const quants = model.gguf && Array.isArray(model.gguf.quantizations) ? model.gguf.quantizations : []
    for (const quant of quants) {
      fromManifest.push(`${model.id}|${quant}|${model.gguf.repo}|${model.gguf.revision}`)
    }
  }
  // matrix() repeats each (model, quant) download cell once per (batchSize,
  // flashAttn) shard, so dedupe to the unique download cells. The mobile matrix
  // is a SUBSET of the manifest (the 4B is desktop-only — it OOMs phones), so
  // assert every mobile cell exists in the manifest with matching repo/revision,
  // rather than requiring equality. A drifted repo/revision/quant is still
  // caught (it won't be in the manifest set).
  const manifestSet = new Set(fromManifest)
  const fromMatrix = [...new Set(matrix().map((c) => `${c.model}|${c.quant}|${c.repo}|${c.revision}`))]
  const notInManifest = fromMatrix.filter((c) => !manifestSet.has(c))
  if (notInManifest.length) {
    console.error('MISMATCH: mobile matrix cells are not in models.manifest.json (mobile must be a subset of the manifest):')
    notInManifest.forEach((c) => console.error(`  ${c}`))
    return 1
  }
  return 0
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
function bidiDiff (label, expected, actual) {
  let bad = 0
  for (const v of expected) {
    if (!actual.has(v)) { bad++; console.error(`MISMATCH: integration.auto.cjs missing ${label} ${v}`) }
  }
  for (const v of actual) {
    if (!expected.has(v)) { bad++; console.error(`MISMATCH: integration.auto.cjs has stale ${label} ${v}`) }
  }
  return bad
}

function checkMobileAuto () {
  if (!fs.existsSync(mobileAutoFile)) {
    console.error(`MISMATCH: integration.auto.cjs not found at ${mobileAutoFile}. Run: npm run test:mobile:generate`)
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
function assertShards () {
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
function writeShards () {
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
  console.log(`Wrote ${written} shard files from the matrix${pruned ? `, pruned ${pruned} orphan(s)` : ''}.`)
}

if (mode === 'groups') {
  for (const batch of workflowBatches()) {
    console.log(`# config: ${batch.config}`)
    console.log(JSON.stringify(batch.groups))
  }
} else if (mode === 'check') {
  const bad = checkManifest() + checkGroups() + checkMobileAuto()
  if (bad) {
    console.error('\nCommitted benchmark artifacts are out of sync with _benchmark-matrix.js.')
    console.error('Run: npm run generate:benchmark-shards && npm run test:mobile:generate, then commit integration.auto.cjs + the workflow groups.')
    process.exit(1)
  }
  console.log(`OK: workflow test_groups and integration.auto.cjs both match the matrix (${matrix().length} shards).`)
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
