import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import stow from 'bare-stow'
import semver from 'semver'
import { discardScratch, scratchFolderFor, type Staged } from '@/commands/bundle/scratch'
import { findInAncestorNodeModules } from '@/expo/plugins/find-in-ancestor-node-modules'
import { AddonLinkFailedError, ReactNativeBareKitUnsupportedError } from '@/utils/errors-client'
import type { Logger } from '@/logging/types'

const REACT_NATIVE_BARE_KIT = 'react-native-bare-kit'

const { link, resources } = stow

/** The folder of the app's assets in a linked module, which an iOS app copies into its bundle. */
export const BARE_KIT_RESOURCES = resources

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

/**
 * The module each phone platform's app builds Bare Kit and the native addons
 * from, relative to the project root.
 */
export const NATIVE_MODULES = {
  android: {
    prefix: 'android-',
    dir: path.join('android', 'qvac-bare-kit'),
    language: 'kotlin',
    languageOptions: { package: 'io.tether.qvac.sdk.addons' }
  },
  ios: {
    prefix: 'ios-',
    dir: path.join('ios', 'QvacBareKit'),
    language: 'swift',
    languageOptions: {}
  }
} as const

export interface StageAddonsOptions {
  projectRoot: string
  /** The worker entry the bundle starts from. */
  entryPath: string
  hosts: string[]
  imports: stow.LinkOptions['imports']
  defer: string[]
  logger: Logger
}

/**
 * Links each phone platform's native module for `hosts`, holding Bare Kit and
 * the native addons the worker loads, into a scratch folder. Returns the files
 * as they will be named in the app, and the staged folders for `replaceAll`;
 * the caller discards them. A failed link discards its own.
 */
export async function stageAddons(
  options: StageAddonsOptions
): Promise<{ written: string[]; staged: Staged[] }> {
  const { projectRoot, entryPath, hosts, imports, defer, logger } = options

  const staged: Staged[] = []
  const written: string[] = []
  try {
    for (const module of Object.values(NATIVE_MODULES)) {
      const platformHosts = hosts.filter((host) => host.startsWith(module.prefix))
      if (platformHosts.length === 0) continue
      // bare-link signs Apple frameworks with codesign.
      if (module.language === 'swift' && process.platform !== 'darwin') {
        logger.warn(`Linking iOS addons needs macOS; skipped ${platformHosts.join(', ')}.`)
        continue
      }

      const out = path.join(projectRoot, module.dir)
      const scratch = await scratchFolderFor(out)
      staged.push({ dir: out, next: scratch })
      const platformWritten: string[] = []
      try {
        for await (const { url } of link(
          pathToFileURL(entryPath).href,
          'bare-kit',
          pathToFileURL(scratch).href,
          {
            language: module.language,
            languageOptions: module.languageOptions,
            hosts: platformHosts,
            ...(imports !== undefined && { imports }),
            defer
          }
        )) {
          const file = path.join(out, path.relative(scratch, fileURLToPath(url.href)))
          logger.debug(`Linked ${path.relative(projectRoot, file)}`)
          platformWritten.push(file)
        }
      } catch (error) {
        throw new AddonLinkFailedError(platformHosts, error)
      }
      // Xcode requires the folder of the assets, even when there are none.
      if (module.language === 'swift') {
        await fsp.mkdir(path.join(scratch, BARE_KIT_RESOURCES), { recursive: true })
      }
      warnOverwritten(platformWritten, out, logger)
      written.push(...platformWritten)
    }
  } catch (error) {
    for (const { next } of staged) await discardScratch(next)
    throw error
  }
  return { written, staged }
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
