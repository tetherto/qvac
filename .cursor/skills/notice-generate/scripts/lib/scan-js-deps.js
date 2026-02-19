'use strict'

const fs = require('fs')
const path = require('path')
const { buildNpmrc } = require('./config')
const { exec, sortByName } = require('./utils')

// ---------------------------------------------------------------------------
// Ensure license-checker is available
// ---------------------------------------------------------------------------
function ensureLicenseChecker () {
  try {
    exec('npx --yes license-checker --version', { stdio: 'ignore' })
  } catch {
    console.log('  Installing license-checker...')
    exec('npm install license-checker', { stdio: 'ignore' })
  }
}

// ---------------------------------------------------------------------------
// Write .npmrc into target dir (already gitignored by packages/**/.npmrc)
// ---------------------------------------------------------------------------
function writeNpmrc (pkgDir) {
  const npmrcPath = path.join(pkgDir, '.npmrc')
  fs.writeFileSync(npmrcPath, buildNpmrc())
  return npmrcPath
}

// ---------------------------------------------------------------------------
// Scan JS production dependencies in a package directory
// dry-run only skips writing NOTICE files — scanning runs fully.
// Returns: [{ name, version, license, url }]
// ---------------------------------------------------------------------------
async function scanJsDeps (pkgDir, log) {
  const pkgJsonPath = path.join(pkgDir, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) {
    log.push(`[JS] No package.json in ${pkgDir}, skipping`)
    return []
  }

  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
  const deps = pkg.dependencies || {}
  if (Object.keys(deps).length === 0) {
    log.push(`[JS] No dependencies in ${pkgDir}, skipping`)
    return []
  }

  ensureLicenseChecker()

  // Write .npmrc for private registry access
  const npmrcPath = writeNpmrc(pkgDir)

  try {
    // Install production deps
    console.log(`  npm install --ignore-scripts in ${path.basename(pkgDir)}...`)
    try {
      exec('npm install --ignore-scripts --production', { cwd: pkgDir, stdio: 'ignore' })
    } catch (err) {
      log.push(`[JS] npm install failed in ${pkgDir}: ${err.message}`)
      return []
    }

    // Run license-checker
    let rawJson
    try {
      rawJson = exec(
        'npx --yes license-checker --production --json --excludePrivatePackages',
        { cwd: pkgDir }
      )
    } catch (err) {
      log.push(`[JS] license-checker failed in ${pkgDir}: ${err.message}`)
      return []
    }

    const data = JSON.parse(rawJson)
    const results = []

    for (const [nameVersion, info] of Object.entries(data)) {
      // license-checker keys are "name@version"
      const atIdx = nameVersion.lastIndexOf('@')
      if (atIdx <= 0) continue

      const name = nameVersion.substring(0, atIdx)
      const version = nameVersion.substring(atIdx + 1)

      // Skip the package itself
      if (name === pkg.name) continue

      const license = typeof info.licenses === 'string'
        ? info.licenses
        : Array.isArray(info.licenses)
          ? info.licenses.join(', ')
          : 'Unknown'

      const url = info.repository || info.url || ''

      results.push({ name, version, license, url })
    }

    return results.sort(sortByName)
  } finally {
    // Clean up .npmrc (it's gitignored but tidy up)
    try { fs.unlinkSync(npmrcPath) } catch { /* ignore */ }
  }
}

module.exports = { scanJsDeps }
