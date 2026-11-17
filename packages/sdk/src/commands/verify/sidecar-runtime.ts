import * as fs from 'fs'
import * as path from 'path'
import { findInAncestorNodeModules } from '@/expo/plugins/find-in-ancestor-node-modules'
import type { BareRuntimeResolution } from '@/commands/verify/abi'

function unresolved(reason: string, triedPaths: string[]): BareRuntimeResolution {
  return { resolved: false, error: { reason, triedPaths } }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** The Bare that the bare-sidecar `from` resolves runs desktop workers on, from its `versions.json`. */
export function resolveSidecarRuntime(from: string): BareRuntimeResolution {
  const dir = findInAncestorNodeModules(from, 'bare-sidecar')
  if (dir === null) {
    return unresolved('bare-sidecar is not installed, so the desktop Bare version is unknown', [
      path.join(from, 'node_modules', 'bare-sidecar')
    ])
  }

  const versionsPath = path.join(dir, 'versions.json')
  const bare = readJson(versionsPath)?.['bare']
  if (typeof bare !== 'string') {
    return unresolved(`${versionsPath} does not name the Bare version`, [versionsPath])
  }

  const version = readJson(path.join(dir, 'package.json'))?.['version']
  const packageVersion = typeof version === 'string' ? version : 'unknown'
  return {
    resolved: true,
    runtime: {
      version: bare,
      source: 'bare-sidecar',
      packageVersion,
      detail: `bare-sidecar ${packageVersion} at ${dir}`
    }
  }
}

/** The Bare of the bare-sidecar that the project's pear-runtime starts workers with. */
export function resolvePearRuntime(projectRoot: string): BareRuntimeResolution {
  const dir = findInAncestorNodeModules(projectRoot, 'pear-runtime')
  if (dir === null) {
    return unresolved('pear-runtime is not installed, so the desktop Bare version is unknown', [
      path.join(projectRoot, 'node_modules', 'pear-runtime')
    ])
  }
  // pnpm links pear-runtime into node_modules; its bare-sidecar sits next to
  // the real directory in the store, not next to the link.
  return resolveSidecarRuntime(fs.realpathSync(dir))
}
