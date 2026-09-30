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
    exec('which license-checker', { stdio: 'ignore' })
  } catch {
    console.log('  Installing license-checker...')
    exec('npx --yes license-checker --production --json --help', { stdio: 'ignore' })
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

// Walk `npm ls --json`. Skip extraneous / invalid / missing nodes so peer
// auto-installs (React Native, Metro, Babel) never land in NOTICE.
function collectInstalledProductionKeys (tree, into = new Set(), nameFromKey) {
  if (!tree || typeof tree !== 'object') return into
  if (tree.extraneous || tree.invalid === true || tree.missing) return into
  const name = tree.name || nameFromKey
  if (name && tree.version) into.add(`${name}@${tree.version}`)
  const deps = tree.dependencies
  if (deps && typeof deps === 'object') {
    for (const [depName, child] of Object.entries(deps)) {
      collectInstalledProductionKeys(child, into, depName)
    }
  }
  return into
}

function npmLsProductionTree (pkgDir) {
  try {
    return JSON.parse(
      exec('npm ls --omit=dev --omit=peer --all --json', { cwd: pkgDir })
    )
  } catch (err) {
    const out = err.stdout
    if (typeof out === 'string' && out.trim().startsWith('{')) {
      return JSON.parse(out)
    }
    throw err
  }
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
    // Fresh tree: a prior peer install leaves extraneous packages that
    // --omit=peer will not prune, and license-checker would list them.
    fs.rmSync(path.join(pkgDir, 'node_modules'), { recursive: true, force: true })

    console.log(`  npm install --ignore-scripts --omit=dev --omit=peer in ${path.basename(pkgDir)}...`)
    try {
      exec('npm install --ignore-scripts --omit=dev --omit=peer', { cwd: pkgDir, stdio: 'ignore' })
    } catch (err) {
      log.push(`[JS] npm install failed in ${pkgDir}: ${err.message}`)
      return []
    }

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

    let productionKeys
    try {
      productionKeys = collectInstalledProductionKeys(npmLsProductionTree(pkgDir))
    } catch (err) {
      log.push(`[JS] npm ls failed in ${pkgDir}: ${err.message}`)
      return []
    }

    const data = JSON.parse(rawJson)
    const results = []
    let dropped = 0

    for (const [nameVersion, info] of Object.entries(data)) {
      // license-checker keys are "name@version"
      const atIdx = nameVersion.lastIndexOf('@')
      if (atIdx <= 0) continue

      const name = nameVersion.substring(0, atIdx)
      const version = nameVersion.substring(atIdx + 1)

      // Skip the package itself
      if (name === pkg.name) continue

      if (!productionKeys.has(nameVersion)) {
        dropped++
        continue
      }

      const license = typeof info.licenses === 'string'
        ? info.licenses
        : Array.isArray(info.licenses)
          ? info.licenses.join(', ')
          : 'Unknown'

      const url = info.repository || info.url || ''

      results.push({ name, version, license, url })
    }

    if (dropped > 0) {
      log.push(`[JS] dropped ${dropped} extraneous/peer packages from ${path.basename(pkgDir)} NOTICE`)
    }

    return results.sort(sortByName)
  } finally {
    // Clean up .npmrc (it's gitignored but tidy up)
    try { fs.unlinkSync(npmrcPath) } catch { /* ignore */ }
  }
}

module.exports = { scanJsDeps, collectInstalledProductionKeys }
