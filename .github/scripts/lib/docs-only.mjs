/**
 * The one classifier of documentation-only changes, shared by every workflow
 * that treats them differently: the release guard exempts them from the
 * version-bump and changelog checks, and the pin-update workflow publishes
 * them by moving a documentation line's pin instead of releasing a package.
 *
 * A change is documentation-only when it changes at least one path and every
 * path it changes lies under a package's documentation root,
 * `packages/<package>/docs/users/`. Generated reference data under that root
 * counts as documentation; a package's examples or contract do not, because
 * they ship in the package.
 */

const DOCS_ROOT = /^packages\/[^/]+\/docs\/users\//

/** Whether one repository path lies under a package's documentation root. */
export function isDocsPath(path) {
  return DOCS_ROOT.test(path)
}

/** Whether a set of changed paths is documentation-only. An empty set is not. */
export function isDocsOnly(paths) {
  const changed = paths.map((path) => path.trim()).filter(Boolean)
  return changed.length > 0 && changed.every(isDocsPath)
}

/** The packages whose documentation roots a set of paths touches, sorted. */
export function docsPackages(paths) {
  const packages = new Set()
  for (const path of paths) {
    const match = /^packages\/([^/]+)\/docs\/users\//.exec(path.trim())
    if (match) packages.add(match[1])
  }
  return [...packages].sort()
}
