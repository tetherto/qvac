'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const { matrix, shardFileName } = require('../test/integration/_benchmark-matrix.js')

const repoRoot = path.resolve(__dirname, '..')
const integrationDir = path.join(repoRoot, 'test', 'integration')
const mobileDir = path.join(repoRoot, 'test', 'mobile')
const outputFile = path.join(mobileDir, 'integration.auto.cjs')

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
    // Only add blank line between functions, not after the last one
    if (i < files.length - 1) {
      lines.push('')
    }
  }

  return `${lines.join('\n')}\n`
}

function main () {
  assertBenchmarkShardsPresent()
  const files = getIntegrationFiles()
  if (files.length === 0) {
    throw new Error(`No integration test files found inside ${integrationDir}`)
  }

  const content = buildFileContents(files)
  fs.writeFileSync(outputFile, content, 'utf8')
  console.log(`Generated ${outputFile} with ${files.length} integration runners.`)
}

if (require.main === module) {
  main()
}
