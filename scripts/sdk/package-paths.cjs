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

function getPackageDir (packageName) {
  if (!packageName || typeof packageName !== 'string') {
    throw new Error('packageName is required')
  }
  return PACKAGE_DIR_OVERRIDES[packageName] || `packages/${packageName}`
}

function getNpmName (packageName) {
  return `@qvac/${packageName}`
}

module.exports = {
  PACKAGE_DIR_OVERRIDES,
  getPackageDir,
  getNpmName
}
