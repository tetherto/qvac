import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { formatAddonId, type NativeAddon } from '@/commands/verify/addon-source'

export interface MissingPrebuildIssue {
  code: 'missing-prebuild'
  level: 'error'
  addon: string
  host: string
  message: string
  packageRoot: string
}

export interface CheckPrebuildsOptions {
  addon: NativeAddon
  hosts: string[]
}

/**
 * One place an addon's prebuild for a host may live. `platformPackage` is set
 * when the directory belongs to a per-platform prebuild package rather than
 * the addon package itself.
 */
export interface PrebuildLocation {
  hostDir: string
  platformPackage?: string
}

const PREBUILDS_DIR = 'prebuilds'
const PLATFORM_ADDON_DIR = 'addon'
const HOST_SEPARATOR = '-'
const IOS_PLATFORM = 'ios'

/**
 * Name of the per-platform prebuild package an addon publishes for `host`.
 *
 * Addons that split their prebuilds (`@qvac/tts-ggml` since 0.9.0, along with
 * `@qvac/asr-ggml` 0.5.0 and `@qvac/audiogen-ggml` 0.4.0) keep the JavaScript
 * in the meta package and install the host's binaries through an `os`/`cpu`
 * filtered optional dependency named `<addon>-<host>`. The iOS device and
 * simulator flavours share one `<addon>-ios` package.
 */
export function platformPackageName(addonName: string, host: string): string {
  const platform = host.split(HOST_SEPARATOR)[0]
  const suffix = platform === IOS_PLATFORM ? IOS_PLATFORM : host
  return `${addonName}${HOST_SEPARATOR}${suffix}`
}

/**
 * Directories to search for an addon's `<host>` prebuild, in precedence order:
 *
 * 1. `<packageRoot>/prebuilds/<host>` — the fat layout every addon used to
 *    publish, and where source builds and `linked:` checkouts still land.
 * 2. `<platformRoot>/addon/prebuilds/<host>` — the per-platform package
 *    resolved from the addon's own package root, when one is installed. Each
 *    platform package embeds an inner `addon/` package named after the meta
 *    addon so the `.bare` file keeps its name.
 *
 * A local `prebuilds/` always wins, matching the precedence the addons apply
 * in their own `binding.js` (`require.addon()` first, platform package second).
 */
export async function resolvePrebuildLocations(
  addon: NativeAddon,
  host: string
): Promise<PrebuildLocation[]> {
  const locations: PrebuildLocation[] = [
    { hostDir: path.join(addon.packageRoot, PREBUILDS_DIR, host) }
  ]

  const platformPackage = platformPackageName(addon.name, host)
  const platformRoot = await findInstalledPackage(addon.packageRoot, platformPackage)
  if (platformRoot !== null) {
    locations.push({
      hostDir: path.join(platformRoot, PLATFORM_ADDON_DIR, PREBUILDS_DIR, host),
      platformPackage
    })
  }

  return locations
}

export async function checkPrebuilds(
  options: CheckPrebuildsOptions
): Promise<MissingPrebuildIssue[]> {
  const { addon, hosts } = options
  const issues: MissingPrebuildIssue[] = []

  for (const host of hosts) {
    const locations = await resolvePrebuildLocations(addon, host)
    if (await anyLocationHasPrebuild(locations)) continue

    issues.push({
      code: 'missing-prebuild',
      level: 'error',
      addon: formatAddonId(addon),
      host,
      packageRoot: addon.packageRoot,
      message: describeMissingPrebuild(addon, host, locations)
    })
  }

  return issues
}

async function anyLocationHasPrebuild(locations: PrebuildLocation[]): Promise<boolean> {
  for (const location of locations) {
    if ((await listBarePrebuildFiles(location.hostDir)).length > 0) return true
  }
  return false
}

function describeMissingPrebuild(
  addon: NativeAddon,
  host: string,
  locations: PrebuildLocation[]
): string {
  const expected = locations.map((location) => path.join(location.hostDir, '*.bare'))
  const platformPackage = platformPackageName(addon.name, host)
  const searchedPlatformPackage = locations.some(
    (location) => location.platformPackage === platformPackage
  )
  const hint = searchedPlatformPackage
    ? ''
    : ` No per-platform package ${platformPackage} is installed alongside it either.`
  return (
    `${formatAddonId(addon)} is missing a prebuild for ${host} ` +
    `(expected ${expected.join(' or ')}).${hint}`
  )
}

/**
 * Locates `packageName` the way Node's resolver would from `fromDir`: in
 * `<dir>/node_modules/<packageName>` for `fromDir` and each of its ancestors.
 * Covers both a hoisted platform package next to the meta package and one
 * nested under the meta package's own `node_modules`.
 */
async function findInstalledPackage(fromDir: string, packageName: string): Promise<string | null> {
  let dir = path.resolve(fromDir)
  for (;;) {
    const candidate = path.join(dir, 'node_modules', packageName)
    if (await isPackageDir(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function isPackageDir(dir: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(path.join(dir, 'package.json'))
    return stat.isFile()
  } catch {
    return false
  }
}

export async function listBarePrebuildFiles(hostDir: string): Promise<string[]> {
  let entries
  try {
    entries = await fsp.readdir(hostDir, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.bare'))
    .map((entry) => path.resolve(hostDir, entry.name))
    .sort()
}
