/**
 * Decide whether a package.json dependency is still pinned to an older major
 * of `bare` or a `bare-*` module.
 *
 * Only `dependencies` and `devDependencies` count. Peer and optional
 * dependencies are out of scope.
 */

'use strict'

const SECTIONS = ['dependencies', 'devDependencies']

export function isBarePackage(name) {
  return name === 'bare' || name.startsWith('bare-')
}

/**
 * Major pinned by a range, or null when the range already accepts a newer major
 * (`*`, `>=`, `>`, `workspace:`).
 */
export function pinnedMajor(range) {
  const spec = String(range).trim()
  if (
    spec === '' ||
    spec === '*' ||
    spec.startsWith('>=') ||
    spec.startsWith('>') ||
    spec.startsWith('workspace:')
  ) {
    return null
  }
  const match = spec.match(/(\d+)\./)
  return match ? Number(match[1]) : null
}

export function versionMajor(version) {
  const match = String(version).match(/^(\d+)\./)
  return match ? Number(match[1]) : null
}

/**
 * True when every alternative in the range is pinned below `latest`.
 * A floating alternative, or one already on the latest major, is current.
 */
export function isBehind(range, latest) {
  const latestMajor = versionMajor(latest)
  if (latestMajor == null) return false
  const alternatives = String(range)
    .split('||')
    .map((part) => part.trim())
    .filter(Boolean)
  if (alternatives.length === 0) return false
  return alternatives.every((alternative) => {
    const major = pinnedMajor(alternative)
    return major != null && major < latestMajor
  })
}

export function bareDeps(manifest) {
  const rows = []
  for (const section of SECTIONS) {
    const block = manifest?.[section]
    if (!block || typeof block !== 'object') continue
    for (const [name, range] of Object.entries(block)) {
      if (!isBarePackage(name) || typeof range !== 'string') continue
      rows.push({ section, name, range })
    }
  }
  return rows
}

export function findLags(rows, latestByName) {
  const lags = []
  for (const row of rows) {
    const latest = latestByName[row.name]
    if (!latest || !isBehind(row.range, latest)) continue
    lags.push({ ...row, latest })
  }
  return lags
}

/**
 * Package manifest that owns `file`, walking parents until `has(path)` is true.
 * `file` is a repo-relative posix path. Returns the `package.json` path or null.
 */
export function nearestPackageJson(file, has) {
  const normalized = String(file).replace(/\\/g, '/').replace(/^\.\//, '')
  let dir
  if (normalized === 'package.json' || normalized.endsWith('/package.json')) {
    dir = normalized.slice(0, -'package.json'.length).replace(/\/$/, '')
  } else {
    const slash = normalized.lastIndexOf('/')
    dir = slash === -1 ? '' : normalized.slice(0, slash)
  }

  while (true) {
    const candidate = dir ? `${dir}/package.json` : 'package.json'
    if (has(candidate)) return candidate
    if (!dir) return null
    const slash = dir.lastIndexOf('/')
    dir = slash === -1 ? '' : dir.slice(0, slash)
  }
}

export function packageJsonsForChangedFiles(files, has) {
  const found = new Set()
  for (const file of files) {
    const manifest = nearestPackageJson(file, has)
    if (manifest) found.add(manifest)
  }
  return [...found]
}

export function formatLag(file, lag) {
  return `${file}: ${lag.section} ${lag.name}@${lag.range} is behind ${lag.latest}`
}
