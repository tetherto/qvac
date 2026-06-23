'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const { matrix, shardFileName } = require('../test/integration/_benchmark-matrix.js')

const repoRoot = path.resolve(__dirname, '..')
const integrationDir = path.join(repoRoot, 'test', 'integration')
const mobileDir = path.join(repoRoot, 'test', 'mobile')
const outputFile = path.join(mobileDir, 'integration.auto.cjs')
const groupsFile = path.join(mobileDir, 'test-groups.json')

// The benchmark-perf-*.test.js shards are generated, not committed (see
// .gitignore), but the committed integration.auto.cjs references them. Enumerating
// the directory without them on disk would silently regenerate this file with the
// benchmark runners dropped, leaving the Benchmark Performance workflow to grep for
// functions that no longer exist and schedule zero tests. Refuse to run unless every
// shard is present. `npm run test:mobile:generate` writes them first; a bare
// invocation must run `npm run generate:benchmark-shards` beforehand.
function assertBenchmarkShardsPresent () {
  const missing = matrix()
    .map(shardFileName)
    .filter(name => !fs.existsSync(path.join(integrationDir, name)))
  if (missing.length) {
    throw new Error(
      `Refusing to regenerate mobile tests: ${missing.length} benchmark shard(s) absent ` +
      `(e.g. ${missing[0]}). Run \`npm run generate:benchmark-shards\` first, or use ` +
      '`npm run test:mobile:generate`, which does it for you.'
    )
  }
}

function getIntegrationFiles () {
  if (!fs.existsSync(integrationDir)) {
    throw new Error(`Integration directory not found: ${integrationDir}`)
  }

  return fs.readdirSync(integrationDir)
    .filter(entry => entry.endsWith('.test.js'))
    .sort()
}

function toFunctionName (fileName) {
  const base = fileName.replace(/\.js$/, '')
  const parts = base.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const suffix = parts.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')
  return `run${suffix}`
}

function buildFileContents (files) {
  const lines = []
  lines.push("'use strict'")
  lines.push("require('./integration-runtime.cjs')")
  lines.push('')
  lines.push('// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.')
  lines.push('// Each function mirrors a single file under test/integration/.')
  lines.push('// Functions are invoked dynamically by the mobile test runner framework.')
  lines.push('')
  lines.push('/* global runIntegrationModule */')
  lines.push('')

  lines.push('/* global __shouldRunTest */')
  lines.push('')
  lines.push('const __FILTERED = { modulePath: \'filtered\', summary: { total: 0, passed: 0, failed: 0 } }')
  lines.push('')

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const fnName = toFunctionName(file)
    const relativePath = `../integration/${file}`
    lines.push(`async function ${fnName} (options = {}) { // eslint-disable-line no-unused-vars`)
    lines.push(`  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('${fnName}')) return __FILTERED`)
    lines.push(`  return runIntegrationModule('${relativePath}', options)`)
    lines.push('}')
    if (i < files.length - 1) {
      lines.push('')
    }
  }

  return `${lines.join('\n')}\n`
}

// A platform's OS family is its name without the optional `Weekly` suffix, so
// `iosWeekly` belongs to the `ios` family. Coverage is validated per family
// (the union of its regular + weekly splits), letting the weekend-only suite
// hold a disjoint subset of tests rather than duplicating the daily ones.
function platformFamily (platform) {
  return platform.replace(/Weekly$/, '')
}

function validateGroups (functionNames) {
  if (!fs.existsSync(groupsFile)) {
    console.warn('[warn] test-groups.json not found — skipping split validation')
    return
  }
  const groups = JSON.parse(fs.readFileSync(groupsFile, 'utf-8'))
  const nameSet = new Set(functionNames)

  // Benchmark shards (benchmark-perf-*.test.js -> runBenchmarkPerf*) are
  // scheduled only by the Benchmark Performance workflow via an explicit
  // test_groups override, and are deliberately absent from test-groups.json
  // so normal mobile integration runs never trigger the heavy benchmark.
  // Exclude them from the group-coverage requirement.
  const isOverrideOnly = (n) => n.startsWith('runBenchmarkPerf')

  const coveredByFamily = new Map()
  for (const [platform, splits] of Object.entries(groups)) {
    const family = platformFamily(platform)
    const covered = coveredByFamily.get(family) ?? new Set()
    for (const name of Object.values(splits).flat()) {
      covered.add(name)
    }
    coveredByFamily.set(family, covered)
  }

  for (const [family, covered] of coveredByFamily) {
    const missing = functionNames.filter(n => !covered.has(n) && !isOverrideOnly(n))
    const extra = [...covered].filter(n => !nameSet.has(n))
    if (missing.length) {
      throw new Error(
        '[' + family + '] Tests not assigned to any group in test-groups.json:\n  ' +
        missing.join('\n  ') +
        `\nAdd them to a ${family} or ${family}Weekly group in test/mobile/test-groups.json.`
      )
    }
    if (extra.length) {
      throw new Error(
        '[' + family + '] test-groups.json references non-existent tests:\n  ' +
        extra.join('\n  ') + '\nRemove them or check for typos.'
      )
    }
  }
  console.log('Group coverage validated — all tests assigned for every OS family.')
}

function main () {
  assertBenchmarkShardsPresent()
  const files = getIntegrationFiles()
  if (files.length === 0) {
    throw new Error(`No integration test files found inside ${integrationDir}`)
  }

  const functionNames = files.map(toFunctionName)
  const content = buildFileContents(files)
  fs.writeFileSync(outputFile, content, 'utf8')
  console.log(`Generated ${outputFile} with ${files.length} integration runners.`)
  validateGroups(functionNames)
}

if (require.main === module) {
  main()
}
