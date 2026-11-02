// Picks which pinned verify-prebuild-symbols revision checks an addon's
// prebuilds. Each revision looks for @qvac/fabric's runtime in one install
// layout, and a backport built by main's workflows still installs the fabric of
// its own release line, so the choice follows the addon's name and version.
//
// verifiers.json maps an addon to ordered ranges; the first range whose `below`
// is greater than the addon's version names its verifier. Unlisted addons, and
// versions past every range, get `current`. Every id in `verifiers` must have a
// matching verify step in reusable-prebuilds.yml, or that addon's prebuild runs
// with no symbol check at all.

import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_VERIFIER = 'current'

const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), 'verifiers.json')

// Numeric x.y.z core only: a prerelease of 0.47.0 is treated as 0.47.0, which is
// built from the same tree as the release.
export function parseVersion(raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(raw ?? '').trim())
  return match ? match.slice(1, 4).map(Number) : null
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

export function validateManifest(manifest) {
  const known = new Set(Array.isArray(manifest?.verifiers) ? manifest.verifiers : [])
  if (!known.has(DEFAULT_VERIFIER)) {
    throw new Error(`verifiers.json must list the '${DEFAULT_VERIFIER}' verifier`)
  }
  for (const [name, ranges] of Object.entries(manifest.addons ?? {})) {
    if (!Array.isArray(ranges) || ranges.length === 0) {
      throw new Error(`verifiers.json: ${name} needs a non-empty list of ranges`)
    }
    let previous = null
    for (const range of ranges) {
      if (!known.has(range?.verifier)) {
        throw new Error(`verifiers.json: ${name} names unknown verifier '${range?.verifier}'`)
      }
      const below = parseVersion(range.below)
      if (!below) {
        throw new Error(`verifiers.json: ${name} has an invalid 'below' version '${range.below}'`)
      }
      if (previous && compareVersions(below, previous) <= 0) {
        throw new Error(`verifiers.json: ${name} ranges must be in ascending 'below' order`)
      }
      previous = below
    }
  }
  return manifest
}

export function selectVerifier(manifest, pkg) {
  const ranges = manifest.addons?.[pkg?.name]
  if (!ranges) return DEFAULT_VERIFIER
  const version = parseVersion(pkg.version)
  if (!version) {
    throw new Error(`${pkg.name} has an unparseable version '${pkg.version}'`)
  }
  for (const range of ranges) {
    if (compareVersions(version, parseVersion(range.below)) < 0) return range.verifier
  }
  return DEFAULT_VERIFIER
}

function readPackage(workdir) {
  try {
    return JSON.parse(readFileSync(join(workdir, 'package.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export function main({ env = process.env, log = console, manifestPath = MANIFEST_PATH } = {}) {
  try {
    const workdir = env.WORKDIR
    if (!workdir) throw new Error('WORKDIR is not set')
    const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
    const pkg = readPackage(workdir)
    const verifier = pkg ? selectVerifier(manifest, pkg) : DEFAULT_VERIFIER
    const subject = pkg ? `${pkg.name}@${pkg.version}` : `${workdir} (no package.json)`
    log.log(`prebuild symbols verifier for ${subject}: ${verifier}`)
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `verifier=${verifier}\n`)
    return 0
  } catch (error) {
    log.log(`::error::${error.message}`)
    return 1
  }
}

// Realpaths, not URL strings: import.meta.url is the percent-encoded realpath
// while argv[1] is the literal path, so a naive comparison breaks whenever a
// segment is a symlink (macOS /tmp -> /private/tmp).
function invokedAsScript() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (invokedAsScript()) {
  process.exitCode = main()
}
