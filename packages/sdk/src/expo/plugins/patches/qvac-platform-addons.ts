/**
 * Resolves split-addon platform packages from the meta package's `#host-addon`
 * map. Linker, verify, and the missing-prebuild error all call this module so
 * the slice name cannot drift from what the addon actually imports.
 *
 * Keep this file free of `@/` imports: the compiled JS is copied next to the
 * patched `link.mjs` as `qvac-platform-addons.mjs`.
 */
import * as fs from 'fs'
import * as path from 'path'

export const HOST_ADDON_IMPORT = '#host-addon'

const DEFAULT_ANDROID_CPU = 'arm64'

export interface PlatformAddonRoot {
  dir: string
  pkg: { name?: string; version?: string; addon?: boolean }
}

export function resolvePlatformAddonRoots(
  projectRoot: string,
  addonNames: string[],
  platform: string
): PlatformAddonRoot[] {
  const roots: PlatformAddonRoot[] = []
  for (const name of addonNames) {
    const root = resolvePlatformAddonRoot(projectRoot, name, platform)
    if (root !== null) roots.push(root)
  }
  return roots
}

function resolvePlatformAddonRoot(
  projectRoot: string,
  metaName: string,
  platform: string
): PlatformAddonRoot | null {
  const metaManifest = readManifest(packageDir(projectRoot, metaName))
  if (metaManifest === null) return null

  const platformPackage = resolveAddonPlatformPackage(
    metaName,
    metaManifest.imports?.[HOST_ADDON_IMPORT],
    platform
  )
  if (platformPackage === null) return null

  const addonDir = path.join(packageDir(projectRoot, platformPackage), 'addon')
  const addonManifest = readManifest(addonDir)
  if (addonManifest === null || addonManifest.addon !== true) return null
  if (!fs.existsSync(path.join(addonDir, 'prebuilds'))) return null

  return { dir: addonDir, pkg: addonManifest }
}

function packageDir(projectRoot: string, packageName: string): string {
  return path.join(projectRoot, 'node_modules', ...packageName.split('/'))
}

interface AddonManifest {
  name?: string
  version?: string
  addon?: boolean
  imports?: Record<string, unknown>
}

function readManifest(dir: string): AddonManifest | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as AddonManifest
  } catch {
    return null
  }
}

/**
 * Package `#host-addon` names for `host`, if that name belongs to `metaName`.
 * `host` is a Bare host (`android-arm64`, `ios-arm64-simulator`, `darwin-arm64`)
 * or a mobile build target (`android`, `ios`).
 */
export function resolveAddonPlatformPackage(
  metaName: string,
  hostAddon: unknown,
  host: string
): string | null {
  const name = resolvePlatformPackageName(hostAddon, host)
  if (name === null) return null
  if (!name.startsWith(`${metaName}-`)) return null
  return name
}

/**
 * First package name a `#host-addon` map points at for `host`.
 * Android nests the package under its architecture; iOS is a flat list.
 * A platform-only `android` target uses arm64, matching the current mobile host.
 */
export function resolvePlatformPackageName(hostAddon: unknown, host: string): string | null {
  if (typeof host !== 'string' || host.length === 0) return null

  const separator = host.indexOf('-')
  const platform = separator === -1 ? host : host.slice(0, separator)
  const cpu = separator === -1 ? '' : host.slice(separator + 1)

  const branch = readBranch(hostAddon, platform)
  const direct = packageName(branch)
  if (direct !== null) return direct

  const cpuKey = cpu.length > 0 ? cpu : DEFAULT_ANDROID_CPU
  return packageName(readBranch(branch, cpuKey))
}

function packageName(candidate: unknown): string | null {
  const name = Array.isArray(candidate) ? candidate[0] : candidate
  if (typeof name !== 'string' || name.startsWith('.')) return null
  return name
}

function readBranch(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (!Object.hasOwn(value, key)) return undefined
  return (value as Record<string, unknown>)[key]
}
