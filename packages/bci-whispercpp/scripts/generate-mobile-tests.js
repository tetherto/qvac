#!/usr/bin/env node
'use strict'

// Prepares everything mobile integration tests need:
//   1. Runs scripts/download-models.sh to fetch model + fixture binaries
//      from the GitHub release (requires GH_TOKEN).
//   2. Copies model files (models/*.bin) into test/mobile/testAssets/.
//   3. Copies fixtures (test/fixtures/manifest.json + *.bin) into the same.
//   4. Regenerates test/mobile/integration.auto.cjs from
//      test/integration/*.test.js so each integration file gets a
//      mobile-friendly wrapper function.
//
// Usage:
//   node scripts/generate-mobile-tests.js            # download (skip if cached) + copy + regen
//   node scripts/generate-mobile-tests.js --force    # re-run download even if assets exist
//   node scripts/generate-mobile-tests.js --skip-download  # only copy + regen
//
// Designed to be the single command CI runs before bundling the mobile
// test app.

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const PACKAGE_DIR = path.resolve(__dirname, '..')
const MODELS_DIR = path.join(PACKAGE_DIR, 'models')
const FIXTURES_DIR = path.join(PACKAGE_DIR, 'test', 'fixtures')
const INTEGRATION_DIR = path.join(PACKAGE_DIR, 'test', 'integration')
const MOBILE_DIR = path.join(PACKAGE_DIR, 'test', 'mobile')
const TEST_ASSETS_DIR = path.join(MOBILE_DIR, 'testAssets')
const AUTO_FILE = path.join(MOBILE_DIR, 'integration.auto.cjs')
const DOWNLOAD_SCRIPT = path.join(PACKAGE_DIR, 'scripts', 'download-models.sh')

const args = new Set(process.argv.slice(2))
const FORCE = args.has('--force')
const SKIP_DOWNLOAD = args.has('--skip-download')

function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function listBins (dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(name => name.endsWith('.bin'))
}

function assetsAlreadyDownloaded () {
  const haveModels = listBins(MODELS_DIR).length > 0
  const haveFixtures = listBins(FIXTURES_DIR).length > 0
  return haveModels && haveFixtures
}

function runDownloadScript () {
  if (SKIP_DOWNLOAD) {
    console.log('[generate-mobile-tests] --skip-download set, skipping download step')
    return
  }
  if (!FORCE && assetsAlreadyDownloaded()) {
    console.log('[generate-mobile-tests] models/ and test/fixtures/ already populated, skipping download (use --force to re-download)')
    return
  }
  if (!fs.existsSync(DOWNLOAD_SCRIPT)) {
    throw new Error(`Download script not found: ${DOWNLOAD_SCRIPT}`)
  }
  console.log(`[generate-mobile-tests] Running ${path.relative(PACKAGE_DIR, DOWNLOAD_SCRIPT)} ...`)
  const result = spawnSync('bash', [DOWNLOAD_SCRIPT], {
    cwd: PACKAGE_DIR,
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    throw new Error(`download-models.sh exited with status ${result.status}`)
  }
}

function copyAssets () {
  ensureDir(TEST_ASSETS_DIR)

  const modelFiles = listBins(MODELS_DIR)
  if (modelFiles.length === 0) {
    throw new Error(`No model .bin files found in ${MODELS_DIR}. Run download-models.sh first.`)
  }

  for (const file of modelFiles) {
    const src = path.join(MODELS_DIR, file)
    const dest = path.join(TEST_ASSETS_DIR, file)
    fs.copyFileSync(src, dest)
    console.log(`[generate-mobile-tests] copied model: ${file}`)
  }

  if (!fs.existsSync(FIXTURES_DIR)) {
    throw new Error(`Fixtures directory not found: ${FIXTURES_DIR}. Run download-models.sh first.`)
  }

  const fixtureEntries = fs.readdirSync(FIXTURES_DIR)
    .filter(name => name.endsWith('.bin') || name === 'manifest.json')

  if (fixtureEntries.length === 0) {
    throw new Error(`No fixture files found in ${FIXTURES_DIR}.`)
  }

  for (const file of fixtureEntries) {
    const src = path.join(FIXTURES_DIR, file)
    const dest = path.join(TEST_ASSETS_DIR, file)
    fs.copyFileSync(src, dest)
    console.log(`[generate-mobile-tests] copied fixture: ${file}`)
  }
}

function getIntegrationFiles () {
  if (!fs.existsSync(INTEGRATION_DIR)) {
    throw new Error(`Integration directory not found: ${INTEGRATION_DIR}`)
  }
  return fs.readdirSync(INTEGRATION_DIR)
    .filter(entry => entry.endsWith('.test.js'))
    .sort()
}

function toFunctionName (fileName) {
  const base = fileName.replace(/\.js$/, '')
  const parts = base.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const suffix = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  return `run${suffix}`
}

function buildAutoFile (files) {
  const lines = []
  const fnNames = files.map(toFunctionName)
  lines.push("'use strict'")
  lines.push("require('./integration-runtime.cjs')")
  lines.push('')
  lines.push('// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.')
  lines.push('// Each function mirrors a single file under test/integration/.')
  lines.push('')
  lines.push('/* global runIntegrationModule */')
  lines.push('')

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const fnName = fnNames[i]
    lines.push(`async function ${fnName} (options = {}) { // eslint-disable-line no-unused-vars`)
    lines.push(`  return runIntegrationModule('../integration/${file}', options)`)
    lines.push('}')
    if (i < files.length - 1) lines.push('')
  }

  lines.push('')
  lines.push('module.exports = {')
  for (let i = 0; i < fnNames.length; i++) {
    const suffix = i < fnNames.length - 1 ? ',' : ''
    lines.push(`  ${fnNames[i]}${suffix}`)
  }
  lines.push('}')

  return lines.join('\n') + '\n'
}

function regenerateAutoFile () {
  ensureDir(MOBILE_DIR)
  const files = getIntegrationFiles()
  if (files.length === 0) {
    throw new Error(`No *.test.js files found in ${INTEGRATION_DIR}`)
  }
  const content = buildAutoFile(files)
  fs.writeFileSync(AUTO_FILE, content, 'utf8')
  console.log(`[generate-mobile-tests] generated ${path.relative(PACKAGE_DIR, AUTO_FILE)} with ${files.length} runner(s)`)
}

function main () {
  runDownloadScript()
  copyAssets()
  regenerateAutoFile()
  console.log('[generate-mobile-tests] done')
}

main()
