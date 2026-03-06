#!/usr/bin/env node

'use strict'

const path = require('path')
const { getPackageList, PACKAGES_DIR } = require('./lib/config')
const { scanAllModels, scanModelsByEngines } = require('./lib/scan-models')
const { scanJsDeps } = require('./lib/scan-js-deps')
const { scanPythonDeps } = require('./lib/scan-python-deps')
const { scanCppDeps } = require('./lib/scan-cpp-deps')
const {
  writePackageNotice,
  writeNoticeLog
} = require('./lib/notice-writer')

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
function printUsage () {
  console.log(`
Usage: node generate-notice.js [--all | <package-dir-name>] [--dry-run]

  --all                     Generate NOTICE for all packages
  <package-dir-name>        Generate NOTICE for a specific package
                            e.g. sdk, qvac-lib-registry-server/client
  --dry-run                 Run all scans but do not write any files.
                            Prints NOTICE previews to stdout instead.

Output:
  Per-package NOTICE        Written into each package directory
  NOTICE_FULL_REPORT.txt    Aggregated report (--all only, gitignored)
  NOTICE_LOG.txt            Warnings and errors (gitignored)

Environment variables (source .env first):
  GH_TOKEN    GitHub token for private repo access
  HF_TOKEN    HuggingFace token for model verification
  NPM_TOKEN   npm registry token for private packages

Examples:
  source .env && node generate-notice.js --all --dry-run
  source .env && node generate-notice.js --all
  source .env && node generate-notice.js sdk
  source .env && node generate-notice.js qvac-lib-infer-llamacpp-embed --dry-run
`)
}

// ---------------------------------------------------------------------------
// Check required env vars
// ---------------------------------------------------------------------------
function checkEnv () {
  const missing = []
  if (!process.env.GH_TOKEN) missing.push('GH_TOKEN')
  if (!process.env.NPM_TOKEN) missing.push('NPM_TOKEN')
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}`)
    console.error('Run: source .env')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Scan a single package
// ---------------------------------------------------------------------------
async function scanPackage (pkgEntry, log) {
  console.log(`\nScanning: ${pkgEntry.npmName} (${pkgEntry.dir})`)
  console.log(`  Scan types: ${pkgEntry.scanTypes.join(', ') || '(none)'}`)

  const scanResult = {
    models: [],
    js: [],
    python: [],
    cpp: []
  }

  for (const scanType of pkgEntry.scanTypes) {
    switch (scanType) {
      case 'models-all':
        console.log('  Scanning models (full list)...')
        scanResult.models = scanAllModels()
        console.log(`  Found ${scanResult.models.length} unique models`)
        break

      case 'models-engine':
        console.log(`  Scanning models for engines: ${pkgEntry.engines.join(', ')}...`)
        scanResult.models = scanModelsByEngines(pkgEntry.engines)
        console.log(`  Found ${scanResult.models.length} unique models`)
        break

      case 'js':
        console.log('  Scanning JS dependencies...')
        scanResult.js = await scanJsDeps(pkgEntry.fullDir, log)
        console.log(`  Found ${scanResult.js.length} JS dependencies`)
        break

      case 'python':
        console.log('  Scanning Python dependencies...')
        scanResult.python = await scanPythonDeps(
          pkgEntry.fullDir, pkgEntry.pythonPaths, log
        )
        console.log(`  Found ${scanResult.python.length} Python dependencies`)
        break

      case 'cpp':
        console.log('  Scanning C++ dependencies...')
        scanResult.cpp = await scanCppDeps(pkgEntry.fullDir, log)
        console.log(`  Found ${scanResult.cpp.length} C++ dependencies`)
        break
    }
  }

  return scanResult
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main () {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const positionalArgs = args.filter(a => !a.startsWith('--'))
  const flagArgs = args.filter(a => a.startsWith('--'))

  if (
    positionalArgs.length === 0 &&
    !flagArgs.includes('--all') &&
    !flagArgs.includes('--help') &&
    !flagArgs.includes('-h')
  ) {
    printUsage()
    process.exit(1)
  }

  if (args.includes('--help') || args.includes('-h')) {
    printUsage()
    process.exit(0)
  }

  checkEnv()

  if (dryRun) {
    console.log('*** DRY-RUN MODE — no files will be written ***\n')
  }

  const allPackages = getPackageList()
  const isAll = flagArgs.includes('--all')
  const log = []
  const writeOpts = { dryRun }

  let packagesToScan

  if (isAll) {
    packagesToScan = allPackages
    console.log(`Generating NOTICE for all ${allPackages.length} packages...`)
  } else {
    const targetDir = positionalArgs[0]

    const match = allPackages.find(p => p.dir === targetDir)
    if (!match) {
      console.error(`Package not found: ${targetDir}`)
      console.error('\nAvailable packages:')
      for (const p of allPackages) {
        console.error(`  ${p.dir} (${p.npmName})`)
      }
      process.exit(1)
    }

    packagesToScan = [match]
    console.log(`Generating NOTICE for ${match.npmName}...`)
  }

  // Scan and write per-package NOTICE files
  const allResults = []

  for (const pkgEntry of packagesToScan) {
    const scanResult = await scanPackage(pkgEntry, log)
    writePackageNotice(pkgEntry, scanResult, writeOpts)
    allResults.push({ pkgEntry, scanResult })
  }

  // Write error log
  writeNoticeLog(log, writeOpts)

  // Summary
  console.log('\nDone!')
  if (log.length > 0) {
    console.log(`\nWarnings/errors: ${log.length}${dryRun ? '' : ' (see NOTICE_LOG.txt)'}`)
    for (const entry of log) {
      console.log(`  ${entry}`)
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(2)
})
