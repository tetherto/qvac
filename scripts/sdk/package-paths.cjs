/**
 * Map changelog/release `--package=` slugs to repo directories.
 * Default: packages/<slug>. Plugins: see PACKAGE_DIR_OVERRIDES.
 */

'use strict'

/** @type {Readonly<Record<string, string>>} */
const PACKAGE_DIR_OVERRIDES = Object.freeze({
  'opencode-plugin': 'plugins/opencode',
  'openclaw-plugin': 'plugins/openclaw'
})

/**
 * Extra directories to scan for changelog PRs beyond a package's own dir.
 * The @qvac/inference engine ships out of the sdk package, and the Python and
 * Kotlin clients are generated from it, version-locked to it, and have no
 * changelog of their own, so commits under those directories belong in the
 * SDK changelog. This widens the PR scan only; version and changelog output
 * still key off the package's own dir.
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
const CHANGELOG_EXTRA_SCAN_DIRS = Object.freeze({
  sdk: Object.freeze([
    'packages/inference',
    'packages/sdk-python',
    'packages/sdk-kotlin'
  ])
})

function getPackageDir (packageName) {
  if (!packageName || typeof packageName !== 'string') {
    throw new Error('packageName is required')
  }
  return PACKAGE_DIR_OVERRIDES[packageName] || `packages/${packageName}`
}

/**
 * All directories whose commits count toward a package's changelog: the
 * package's own dir plus any CHANGELOG_EXTRA_SCAN_DIRS entries.
 * @param {string} packageName
 * @returns {string[]}
 */
function getChangelogScanDirs (packageName) {
  const own = getPackageDir(packageName)
  const extra = CHANGELOG_EXTRA_SCAN_DIRS[packageName] || []
  return [own, ...extra]
}

function getNpmName (packageName) {
  return `@qvac/${packageName}`
}

module.exports = {
  PACKAGE_DIR_OVERRIDES,
  CHANGELOG_EXTRA_SCAN_DIRS,
  getPackageDir,
  getChangelogScanDirs,
  getNpmName
}
