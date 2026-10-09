import { promises as fsp } from 'node:fs'
import path from 'node:path'
import link from 'bare-link'
import { findInAncestorNodeModules } from '@/expo/plugins/find-in-ancestor-node-modules'
import { AddonLinkFailedError } from '@/utils/errors-client'
import type { Logger } from '@/logging/types'

/** Where react-native-bare-kit builds each platform's linked addons from. */
const PLATFORMS = [
  { prefix: 'android-', out: ['android', 'src', 'main', 'addons'] },
  { prefix: 'ios-', out: ['ios', 'addons'] }
]

export interface LinkAddonsOptions {
  projectRoot: string
  entryPath: string
  hosts: string[]
  logger: Logger
}

export function resolveBareKitDir(projectRoot: string): string | null {
  return findInAncestorNodeModules(projectRoot, 'react-native-bare-kit')
}

/**
 * Links the native addons of the worker entry into react-native-bare-kit for
 * each phone platform in `hosts`, replacing what the platform had. Returns the
 * paths written.
 */
export async function linkAddons(options: LinkAddonsOptions): Promise<string[]> {
  const { projectRoot, entryPath, hosts, logger } = options

  const bareKitDir = resolveBareKitDir(projectRoot)
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
    try {
      for await (const resource of link(entryPath, { hosts: platformHosts, out })) {
        logger.debug(`   Linked ${path.relative(projectRoot, resource)}`)
        written.push(resource)
      }
    } catch (error) {
      throw new AddonLinkFailedError(platformHosts, error)
    }
  }
  return written
}
