import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { formatAddonId, type NativeAddon } from '@/commands/verify/addon-source'
import {
  HOST_ADDON_IMPORT,
  resolveAddonPlatformPackage
} from '@/expo/plugins/patches/qvac-platform-addons'

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

/**
 * Directories to search for an addon's `<host>` prebuild, in precedence order:
 *
 * 1. `<packageRoot>/prebuilds/<host>` — the fat layout every addon used to
 *    publish, and where source builds and `linked:` checkouts still land.
 * 2. `<platformRoot>/addon/prebuilds/<host>` — the per-platform package the
 *    addon's `#host-addon` map names for this host, when that package is
 *    installed. Each platform package embeds an inner `addon/` package named
 *    after the meta addon so the `.bare` file keeps its name.
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

  const platformPackage = await platformPackageForHost(addon, host)
  if (platformPackage === null) return locations

  const platformRoot = await findInstalledPackage(
    await realPackageRoot(addon.packageRoot),
    platformPackage
  )
  if (platformRoot !== null) {
    locations.push({
      hostDir: path.join(platformRoot, PLATFORM_ADDON_DIR, PREBUILDS_DIR, host),
      platformPackage
    })
  }

  return locations
}

/**
 * The directory the addon really lives in. Under pnpm's isolated layout
 * `node_modules/@qvac/tts-ggml` is a symlink into the virtual store
 * (`node_modules/.pnpm/<id>/node_modules/@qvac/tts-ggml`), and the addon's
 * dependencies — its platform package included — are linked next to it in
 * that store directory rather than at the project's top-level `node_modules`.
 * Node resolves from the real path, so the platform-package search starts
 * there too. An unresolvable path (a fixture, a bundle path that no longer
 * exists) is searched as given.
 */
async function realPackageRoot(packageRoot: string): Promise<string> {
  try {
    return await fsp.realpath(packageRoot)
  } catch {
    return path.resolve(packageRoot)
  }
}

export async function checkPrebuilds(
  options: CheckPrebuildsOptions
): Promise<MissingPrebuildIssue[]> {
  const { addon, hosts } = options
  const issues: MissingPrebuildIssue[] = []

  for (const host of hosts) {
    if (addon.linkedHosts !== undefined && !addon.linkedHosts.includes(host)) continue

    const locations = await resolvePrebuildLocations(addon, host)
    if (await anyLocationHasPrebuild(locations)) continue

    issues.push({
      code: 'missing-prebuild',
      level: 'error',
      addon: formatAddonId(addon),
      host,
      packageRoot: addon.packageRoot,
      message: await describeMissingPrebuild(addon, host, locations)
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

async function describeMissingPrebuild(
  addon: NativeAddon,
  host: string,
  locations: PrebuildLocation[]
): Promise<string> {
  const expected = locations.map((location) => path.join(location.hostDir, '*.bare'))
  const platformPackage = await platformPackageForHost(addon, host)
  const searchedPlatformPackage = locations.some(
    (location) => location.platformPackage === platformPackage
  )
  return (
    `${formatAddonId(addon)} is missing a prebuild for ${host} ` +
    `(expected ${expected.join(' or ')}).` +
    missingPlatformPackageHint(addon, platformPackage, searchedPlatformPackage)
  )
}

function missingPlatformPackageHint(
  addon: NativeAddon,
  platformPackage: string | null,
  searchedPlatformPackage: boolean
): string {
  if (platformPackage === null || searchedPlatformPackage) return ''
  const pin =
    addon.version === undefined ? platformPackage : `"${platformPackage}": "${addon.version}"`
  return (
    ` Add this exact dependency to package.json (same version as ${addon.name})` +
    ` and reinstall: ${pin}`
  )
}

async function platformPackageForHost(addon: NativeAddon, host: string): Promise<string | null> {
  return resolveAddonPlatformPackage(addon.name, await readHostAddonMap(addon), host)
}

async function readHostAddonMap(addon: NativeAddon): Promise<unknown> {
  try {
    const raw = await fsp.readFile(path.join(addon.packageRoot, 'package.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const imports = (parsed as { imports?: Record<string, unknown> }).imports
    return imports?.[HOST_ADDON_IMPORT]
  } catch {
    return undefined
  }
}

/**
 * Locates `packageName` the way Node's resolver would from `fromDir`: in
 * `<dir>/node_modules/<packageName>` for `fromDir` and each of its ancestors.
 * Covers a hoisted platform package next to the meta package, one nested
 * under the meta package's own `node_modules`, and — given the meta package's
 * real path — the sibling link pnpm places in its virtual-store directory.
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
