/**
 * Resolves split-addon platform packages from the meta package's `#host-addon`
 * map, so verify and the missing-prebuild error name the package the addon
 * actually imports.
 */
export const HOST_ADDON_IMPORT = '#host-addon'

const DEFAULT_ANDROID_CPU = 'arm64'

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
