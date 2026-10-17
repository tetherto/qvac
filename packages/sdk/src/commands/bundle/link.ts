import { promises as fsp } from 'node:fs'
import path from 'node:path'
import link from 'bare-link'
import semver from 'semver'
import { findInAncestorNodeModules } from '@/expo/plugins/find-in-ancestor-node-modules'
import { AddonLinkFailedError, ReactNativeBareKitUnsupportedError } from '@/utils/errors-client'
import type { Logger } from '@/logging/types'

const REACT_NATIVE_BARE_KIT = 'react-native-bare-kit'

interface PackageManifest {
  version?: unknown
  peerDependencies?: Record<string, unknown>
}

async function readManifest(dir: string): Promise<PackageManifest | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8')) as PackageManifest
  } catch {
    return null
  }
}

/** Checks the installed react-native-bare-kit against the SDK's peer range for it. */
export async function assertReactNativeBareKitSupported(
  projectRoot: string,
  sdkPath: string
): Promise<void> {
  const bareKitDir = findInAncestorNodeModules(projectRoot, REACT_NATIVE_BARE_KIT)
  if (bareKitDir === null) return

  const required = (await readManifest(sdkPath))?.peerDependencies?.[REACT_NATIVE_BARE_KIT]
  const installed = (await readManifest(bareKitDir))?.version
  if (typeof required !== 'string' || typeof installed !== 'string') return
  if (semver.satisfies(installed, required, { includePrerelease: true })) return

  throw new ReactNativeBareKitUnsupportedError(installed, required)
}

/** Where react-native-bare-kit builds each platform's linked addons from. */
const PLATFORMS = [
  { prefix: 'android-', out: ['android', 'src', 'main', 'addons'] },
  { prefix: 'ios-', out: ['ios', 'addons'] }
]

export interface LinkAddonsOptions {
  projectRoot: string
  addonModules: string[]
  hosts: string[]
  logger: Logger
}

/**
 * Links the native addons the bundle loads into react-native-bare-kit for
 * each phone platform in `hosts`, replacing what the platform had.
 */
export async function linkAddons(options: LinkAddonsOptions): Promise<string[]> {
  const { projectRoot, addonModules, hosts, logger } = options

  const bareKitDir = findInAncestorNodeModules(projectRoot, REACT_NATIVE_BARE_KIT)
  if (bareKitDir === null) {
    logger.warn('react-native-bare-kit is not installed; the native addons were not linked.')
    return []
  }

  const written: string[] = []
  for (const platform of PLATFORMS) {
    const platformHosts = hosts.filter((host) => host.startsWith(platform.prefix))
    if (platformHosts.length === 0) continue
    // bare-link signs Apple frameworks with codesign.
    if (platform.prefix === 'ios-' && process.platform !== 'darwin') {
      logger.warn(`Linking iOS addons needs macOS; skipped ${platformHosts.join(', ')}.`)
      continue
    }

    const out = path.join(bareKitDir, ...platform.out)
    await fsp.rm(out, { recursive: true, force: true })
    const platformWritten: string[] = []
    try {
      for await (const resource of link(addonModules, { hosts: platformHosts, out })) {
        logger.debug(`Linked ${path.relative(projectRoot, resource)}`)
        platformWritten.push(resource)
      }
    } catch (error) {
      throw new AddonLinkFailedError(platformHosts, error)
    }
    warnOverwritten(platformWritten, out, logger)
    written.push(...platformWritten)
  }
  return written
}

/**
 * Addons that ship a library under the same name write it to the same path,
 * and the copy linked last is the one the app loads.
 */
export function warnOverwritten(written: string[], out: string, logger: Logger) {
  const seen = new Set<string>()
  const overwritten = new Set<string>()
  for (const file of written) {
    if (seen.has(file)) overwritten.add(file)
    seen.add(file)
  }
  if (overwritten.size === 0) return
  const files = [...overwritten].map((file) => path.relative(out, file)).sort()
  logger.warn(`Several native addons ship ${files.join(', ')}; only the copy linked last is kept.`)
}
