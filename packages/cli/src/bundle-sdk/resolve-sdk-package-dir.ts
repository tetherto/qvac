import fs from 'node:fs'
import path from 'node:path'
import {
  SdkNotFoundInNodeModulesError,
  MultipleSdkInstallationsError
} from '../errors.js'

/*
 * Sister file: packages/sdk/expo/plugins/resolve-sdk-package-dir.ts
 *
 * The CLI and the SDK Expo plugin both need to find a hoisted SDK install
 * starting from a consumer's projectRoot. They cannot share runtime code
 * because @qvac/cli must not pull @qvac/sdk in as a regular dependency
 * (the SDK is the very thing the CLI bundles at the consumer's site, not
 * something the CLI consumes itself). Keep the two implementations
 * behaviorally identical instead. If you change resolution semantics here,
 * mirror the change in the SDK file and the parallel test suites.
 */

const SDK_PACKAGE_NAMES = [
  '@qvac/sdk',
  '@tetherto/sdk-mono',
  '@tetherto/sdk-dev'
]

interface SdkPackageInfo {
  dir: string
  name: string
}

interface SdkMatch extends SdkPackageInfo {
  depth: number
}

function findAllInAncestorNodeModules (
  startDir: string,
  name: string
): SdkMatch[] {
  const matches: SdkMatch[] = []
  let dir = startDir
  let parent = path.dirname(dir)
  let depth = 0
  for (; dir !== parent; dir = parent, parent = path.dirname(dir), depth++) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(candidate)) {
      matches.push({ name, dir: candidate, depth })
    }
  }
  return matches
}

/**
 * Walks from projectRoot up to the filesystem root, checking each
 * node_modules directory for a known SDK package. Closest match to
 * projectRoot wins; shadowed copies are surfaced via console.warn.
 *
 * Throws MultipleSdkInstallationsError only when two *different* SDK package
 * names share the same closest depth (a real ambiguity that no first-match
 * heuristic can resolve).
 */
export function resolveSdkPackageDir (projectRoot: string): SdkPackageInfo {
  const allMatches: SdkMatch[] = []
  for (const name of SDK_PACKAGE_NAMES) {
    allMatches.push(...findAllInAncestorNodeModules(projectRoot, name))
  }

  if (allMatches.length === 0) {
    throw new SdkNotFoundInNodeModulesError(projectRoot, SDK_PACKAGE_NAMES)
  }

  const minDepth = Math.min(...allMatches.map((m) => m.depth))
  const closest = allMatches.filter((m) => m.depth === minDepth)

  if (closest.length > 1) {
    throw new MultipleSdkInstallationsError(closest.map((m) => m.name))
  }

  const winner = closest[0]!
  const shadowed = allMatches.filter((m) => m !== winner)
  if (shadowed.length > 0) {
    const others = shadowed.map((m) => `"${m.name}" at "${m.dir}"`).join(', ')
    console.warn(
      `[resolveSdkPackageDir] Multiple SDK installations found; using ` +
      `"${winner.name}" at "${winner.dir}" (closest to projectRoot). ` +
      `Ignoring: ${others}.`
    )
  }

  return { name: winner.name, dir: winner.dir }
}

export { SDK_PACKAGE_NAMES }
export type { SdkPackageInfo }
