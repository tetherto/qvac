#!/usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')
const {
  REPO_ROOT,
  ALLOWED_LICENSES,
  isLicenseAllowed,
  getPackageList
} = require('./lib/config')
const { scanAllModels } = require('./lib/scan-models')
const { scanJsDeps } = require('./lib/scan-js-deps')
const { scanPythonDeps } = require('./lib/scan-python-deps')
const { scanCppDeps } = require('./lib/scan-cpp-deps')

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
function printUsage () {
  console.log(`
Usage: node check-forbidden-licenses.js [--all | <package-dir-name>] [--dry-run]

Scans dependencies and checks licenses against the allowed list.
When ALLOWED_LICENSES is empty in config.js every license passes (open gate).
Once populated, any dependency whose license is NOT in the list is a violation.

Outputs FORBIDDEN_LICENSES.txt in the repo root if violations are found.

  --all                     Check all packages
  <package-dir-name>        Check a specific package
  --dry-run                 Skip npm install (use existing node_modules or
                            declared deps only). No files written — console only.

Allowed licenses (currently ${ALLOWED_LICENSES.length === 0 ? 'EMPTY — all allowed' : ALLOWED_LICENSES.length + ' entries'}):
  ${ALLOWED_LICENSES.length === 0 ? '(none — every license passes)' : ALLOWED_LICENSES.join(', ')}

Environment variables (source .env first):
  GH_TOKEN    GitHub token for private repo access
  NPM_TOKEN   npm registry token for private packages

Examples:
  source .env && node check-forbidden-licenses.js --all --dry-run
  source .env && node check-forbidden-licenses.js --all
  source .env && node check-forbidden-licenses.js qvac-sdk
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

  if (ALLOWED_LICENSES.length === 0) {
    console.log('ALLOWED_LICENSES is empty — every license passes (open gate).')
    console.log('Populate the list in config.js to enforce an allowlist.\n')
  }

  const allPackages = getPackageList()
  const isAll = flagArgs.includes('--all')
  const log = []
  const violations = [] // { package, depType, depName, license }

  let packagesToScan

  if (isAll) {
    packagesToScan = allPackages
    console.log(`Checking licenses across all ${allPackages.length} packages...\n`)
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
    console.log(`Checking licenses for ${match.npmName}...\n`)
  }

  // Scan all models once (deduped across packages)
  console.log('Scanning models...')
  const allModels = scanAllModels()
  for (const model of allModels) {
    if (!isLicenseAllowed(model.license)) {
      violations.push({
        package: '(all — models.prod.json)',
        depType: 'Model',
        depName: model.name,
        license: model.license,
        url: model.url
      })
    }
  }
  console.log(`  Checked ${allModels.length} models`)

  for (const pkgEntry of packagesToScan) {
    console.log(`\nChecking: ${pkgEntry.npmName} (${pkgEntry.dir})`)

    // JS deps
    if (pkgEntry.scanTypes.includes('js')) {
      console.log('  Scanning JS dependencies...')
      const jsDeps = await scanJsDeps(pkgEntry.fullDir, log)
      for (const dep of jsDeps) {
        if (!isLicenseAllowed(dep.license)) {
          violations.push({
            package: pkgEntry.npmName,
            depType: 'JS',
            depName: `${dep.name}@${dep.version}`,
            license: dep.license,
            url: dep.url
          })
        }
      }
      console.log(`  Checked ${jsDeps.length} JS dependencies`)
    }

    // Python deps
    if (pkgEntry.scanTypes.includes('python')) {
      console.log('  Scanning Python dependencies...')
      const pyDeps = await scanPythonDeps(pkgEntry.fullDir, pkgEntry.pythonPaths, log)
      for (const dep of pyDeps) {
        if (!isLicenseAllowed(dep.license)) {
          violations.push({
            package: pkgEntry.npmName,
            depType: 'Python',
            depName: dep.name,
            license: dep.license,
            url: dep.url
          })
        }
      }
      console.log(`  Checked ${pyDeps.length} Python dependencies`)
    }

    // C++ deps
    if (pkgEntry.scanTypes.includes('cpp')) {
      console.log('  Scanning C++ dependencies...')
      const cppDeps = await scanCppDeps(pkgEntry.fullDir, log)
      for (const dep of cppDeps) {
        if (!isLicenseAllowed(dep.license)) {
          violations.push({
            package: pkgEntry.npmName,
            depType: 'C++',
            depName: dep.name,
            license: dep.license,
            url: dep.url
          })
        }
      }
      console.log(`  Checked ${cppDeps.length} C++ dependencies`)
    }
  }

  // Output results
  console.log('\n' + '='.repeat(60))

  if (violations.length === 0) {
    console.log('All licenses are allowed.')
    // Remove stale file if it exists
    const outPath = path.join(REPO_ROOT, 'FORBIDDEN_LICENSES.txt')
    if (!dryRun && fs.existsSync(outPath)) {
      fs.unlinkSync(outPath)
      console.log('Removed stale FORBIDDEN_LICENSES.txt')
    }
    process.exit(0)
  }

  console.log(`FOUND ${violations.length} LICENSE VIOLATION(S):\n`)

  const allowedLabel = ALLOWED_LICENSES.length === 0
    ? '(empty — all allowed, so this should not happen)'
    : ALLOWED_LICENSES.join(', ')

  const lines = [
    `License Violations — ${new Date().toISOString()}`,
    '',
    `${violations.length} violation(s) found.`,
    '',
    `Allowed license list: ${allowedLabel}`,
    '',
    '---',
    ''
  ]

  // Sort violations deterministically
  violations.sort((a, b) => {
    const cmp = a.package.localeCompare(b.package)
    if (cmp !== 0) return cmp
    const cmp2 = a.depType.localeCompare(b.depType)
    if (cmp2 !== 0) return cmp2
    return a.depName.localeCompare(b.depName)
  })

  for (const v of violations) {
    const entry = [
      `Package:    ${v.package}`,
      `Dependency: ${v.depName}`,
      `Type:       ${v.depType}`,
      `License:    ${v.license}`,
      `URL:        ${v.url || 'n/a'}`,
      ''
    ].join('\n')
    lines.push(entry)
    console.log(entry)
  }

  if (dryRun) {
    console.log('[dry-run] Would write FORBIDDEN_LICENSES.txt')
  } else {
    const outPath = path.join(REPO_ROOT, 'FORBIDDEN_LICENSES.txt')
    fs.writeFileSync(outPath, lines.join('\n') + '\n')
    console.log(`Wrote ${outPath}`)
  }

  process.exit(1)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(2)
})
