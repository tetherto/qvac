import { promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import semver from 'semver'
import {
  BARE_KIT_BARE_VERSIONS,
  BARE_KIT_KOTLIN_BARE_KITS,
  BARE_KIT_KOTLIN_WITHOUT_BARE_KIT,
  BARE_KIT_SWIFT_BARE_KITS,
  BARE_KIT_SWIFT_WITHOUT_BARE_KIT,
  BARE_KIT_WITHOUT_BARE
} from '@/commands/verify/bare-kit-runtimes'
import { DEFAULT_IOS_ENGINE, type IosEngine } from '@/commands/bundle/ios-engine'
import { findInAncestorNodeModules } from '@/expo/plugins/find-in-ancestor-node-modules'
import type { BareKitBinding, BareRuntimeResolution } from '@/commands/verify/abi'

export const REACT_NATIVE_BARE_KIT = 'react-native-bare-kit'

export const NETWORK_TIMEOUT_MS = 5000

const RAW_GITHUB_BASE = 'https://raw.githubusercontent.com/holepunchto'

const GITHUB_BASE = 'https://github.com/holepunchto'

/** The bare-stow file that pins the Bare Kit bindings phone apps link. */
const BARE_KIT_TARGET = path.join('lib', 'target', 'bare-kit.js')

export type BareKitPlatform = 'android' | 'ios'

export const BARE_KIT_PLATFORMS: BareKitPlatform[] = ['android', 'ios']

interface BindingInfo {
  name: BareKitBinding
  bareKits: Record<string, string>
  /** Releases the table generator checked and found naming no bare-kit version. */
  withoutBareKit: string[]
  pin: RegExp
}

const BINDINGS: Record<BareKitPlatform, BindingInfo> = {
  android: {
    name: 'bare-kit-kotlin',
    bareKits: BARE_KIT_KOTLIN_BARE_KITS,
    withoutBareKit: BARE_KIT_KOTLIN_WITHOUT_BARE_KIT,
    // Exact version, or a Gradle range like `0.2.+`.
    pin: /['"]com\.github\.holepunchto\.bare-kit-kotlin:bare-kit-kotlin['"]\s*:\s*['"]v?(\d+(?:\.\d+)*\.\+|\d+\.\d+\.\d+[^'"\s]*)['"]/
  },
  ios: {
    name: 'bare-kit-swift',
    bareKits: BARE_KIT_SWIFT_BARE_KITS,
    withoutBareKit: BARE_KIT_SWIFT_WITHOUT_BARE_KIT,
    // One entry per engine; the rest of the entry names the traits of the engine.
    pin: /['"]https:\/\/github\.com\/holepunchto\/bare-kit-swift(?:\.git)?['"]\s*,\s*from\s*:\s*['"]v?(\d+\.\d+\.\d+[^'"\s]*)['"]([^}]*)/g
  }
}

/** The trait bare-stow enables on bare-kit-swift for each engine other than its default. */
const IOS_ENGINE_TRAITS: Partial<Record<IosEngine, string>> = { javascriptcore: 'JavaScriptCore' }

export type FetchText = (url: string) => Promise<string>

export type ProgressFn = (message: string) => void

export interface ResolveBareKitRuntimeOptions {
  platform: BareKitPlatform
  /** The project whose `@qvac/sdk` decides which bare-stow's pins are read. */
  projectRoot?: string | undefined
  /** Directory of the bare-stow package whose pins are read, instead of the project's. */
  bareStowDir?: string | undefined
  network?: boolean | undefined
  /** The engine the iOS worker runs with, which decides the bare-kit-swift entry read. */
  iosEngine?: IosEngine | undefined
  onProgress?: ProgressFn | undefined
  fetchText?: FetchText | undefined
}

export function isReactNativeBareKitInstalled(projectRoot: string) {
  return findInAncestorNodeModules(projectRoot, REACT_NATIVE_BARE_KIT) !== null
}

export function bareKitPlatformOf(host: string): BareKitPlatform | null {
  if (host.startsWith('android-')) return 'android'
  if (host.startsWith('ios-')) return 'ios'
  return null
}

export async function fetchText(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`)
  return response.text()
}

export function parseBareVersion(cmakeLists: string) {
  const match = /fetch_package\(\s*"github:holepunchto\/bare@(\d+\.\d+\.\d+[^"\s]*)"/.exec(
    cmakeLists
  )
  return match?.[1] ?? null
}

export function parseBareKitVersion(cmakeLists: string) {
  const match = /fetch_package\(\s*"github:holepunchto\/bare-kit@(\d+\.\d+\.\d+[^"\s]*)"/.exec(
    cmakeLists
  )
  return match?.[1] ?? null
}

/** Whether Gradle resolves `pin` at the newest matching release, as for `0.2.+`. */
export function isDynamicPin(pin: string) {
  return pin.endsWith('+')
}

/** Newest version matching a Gradle range like `0.2.+`, or null. */
export function newestMatchingPin(pin: string, versions: string[]) {
  const prefix = pin.slice(0, -1)
  const matching = versions.filter(
    (version) => version.startsWith(prefix) && semver.valid(version) !== null
  )
  return matching.sort(semver.rcompare)[0] ?? null
}

/**
 * Newest version Swift Package Manager resolves `from: minimum` at: below the
 * next major, or the next minor before 1.0.0. Null when none matches.
 */
export function newestFromMinimum(minimum: string, versions: string[]) {
  const matching = versions.filter(
    (version) => semver.valid(version) !== null && semver.satisfies(version, `^${minimum}`)
  )
  return matching.sort(semver.rcompare)[0] ?? null
}

/** The binding version bare-stow pins for each platform, or null where none is found. */
export function parseBareKitPins(
  source: string,
  iosEngine: IosEngine = DEFAULT_IOS_ENGINE
): Record<BareKitPlatform, string | null> {
  const swift = [...source.matchAll(BINDINGS.ios.pin)]
  const trait = IOS_ENGINE_TRAITS[iosEngine]
  const entry =
    swift.find(([, , rest]) =>
      trait === undefined ? !rest!.includes('traits') : rest!.includes(trait)
    ) ?? swift[0]
  return {
    android: BINDINGS.android.pin.exec(source)?.[1] ?? null,
    ios: entry?.[1] ?? null
  }
}

/** Released versions of a Bare Kit binding, from the tags of its repository. */
export async function fetchBindingReleasesFromGitHub(
  binding: BareKitBinding,
  fetch: FetchText = fetchText
) {
  const refs = await fetch(`${GITHUB_BASE}/${binding}/info/refs?service=git-upload-pack`)
  return [...refs.matchAll(/refs\/tags\/v?(\d+\.\d+\.\d+)$/gm)].map((match) => match[1]!)
}

export async function fetchBindingBareKitFromGitHub(
  binding: BareKitBinding,
  version: string,
  fetch: FetchText = fetchText
) {
  const cmakeLists = await fetch(`${RAW_GITHUB_BASE}/${binding}/v${version}/CMakeLists.txt`)
  return parseBareKitVersion(cmakeLists)
}

export async function fetchBareVersionFromGitHub(
  bareKitVersion: string,
  fetch: FetchText = fetchText
) {
  const cmakeLists = await fetch(`${RAW_GITHUB_BASE}/bare-kit/v${bareKitVersion}/CMakeLists.txt`)
  return parseBareVersion(cmakeLists)
}

/** The bare-stow of the project's `@qvac/sdk`, which bundles its app, else this SDK's. */
function resolveBareStowDir(projectRoot: string | undefined) {
  const projectSdk =
    projectRoot === undefined ? null : findInAncestorNodeModules(projectRoot, '@qvac/sdk')
  const from = projectSdk ? path.join(projectSdk, 'package.json') : import.meta.url
  return path.dirname(createRequire(from).resolve('bare-stow/package'))
}

function unresolved(reason: string, triedPaths: string[]): BareRuntimeResolution {
  return { resolved: false, error: { reason, triedPaths } }
}

interface PinnedRelease {
  /** The version bare-stow names: an exact one, a Gradle range or a Swift minimum. */
  pin: string
  version: string
  /** Whether the app's build tool picks the newest release matching `pin`. */
  floating: boolean
  /** Whether `version` is the newest among the releases on GitHub, not only the built-in table. */
  latestChecked: boolean
}

function resolved(
  platform: BareKitPlatform,
  bare: string,
  release: PinnedRelease,
  bareKit: string,
  viaGitHub: boolean
): BareRuntimeResolution {
  const binding = BINDINGS[platform].name
  const { pin, version } = release
  const range = platform === 'ios' ? `${pin} or newer` : pin
  const pinned = release.floating
    ? `${range} (${release.latestChecked ? 'newest release' : 'newest known release'} ${version})`
    : version
  return {
    resolved: true,
    runtime: {
      version: bare,
      source: binding,
      packageVersion: version,
      detail:
        `bare-stow pins ${binding} ${pinned}, built from bare-kit ${bareKit}` +
        (viaGitHub ? ', looked up on GitHub' : '')
    }
  }
}

/**
 * Bare version a phone platform runs: the one in the bare-kit that the Bare
 * Kit binding pinned by the SDK's bare-stow is built from. Android pins
 * bare-kit-kotlin exactly or as a Gradle range like `0.2.+`, and iOS pins a
 * minimum bare-kit-swift version. The app's build resolves a range or a
 * minimum at the newest matching release, so this does too: among the
 * releases on GitHub, or among those in the built-in table without the network.
 *
 * The Bare version of a release comes from the built-in tables, and only then
 * from GitHub.
 */
export async function resolveBareKitRuntime(
  options: ResolveBareKitRuntimeOptions
): Promise<BareRuntimeResolution> {
  const { platform, network = true, onProgress, fetchText: fetch = fetchText } = options
  const binding = BINDINGS[platform]

  let bareStowDir: string
  try {
    bareStowDir = options.bareStowDir ?? resolveBareStowDir(options.projectRoot)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return unresolved(
      `bare-stow could not be resolved from the SDK, so the ${platform} Bare version is unknown: ${message}`,
      []
    )
  }

  const targetPath = path.join(bareStowDir, BARE_KIT_TARGET)
  let source: string
  try {
    source = await fsp.readFile(targetPath, 'utf8')
  } catch {
    return unresolved(`Could not read ${targetPath}, so the ${platform} Bare version is unknown`, [
      targetPath
    ])
  }

  const pin = parseBareKitPins(source, options.iosEngine)[platform]
  if (pin === null) {
    return unresolved(
      `${targetPath} pins no ${binding.name} version, so the ${platform} Bare version is unknown`,
      [targetPath]
    )
  }

  const floating = platform === 'ios' || isDynamicPin(pin)
  const newest = (versions: string[]) =>
    platform === 'ios' ? newestFromMinimum(pin, versions) : newestMatchingPin(pin, versions)

  let version: string | null = pin
  let latestChecked = false
  if (floating) {
    const known = Object.keys(binding.bareKits)
    version = newest(known)
    if (network) {
      onProgress?.(`Checking the newest ${binding.name} release on github.com...`)
      try {
        version = newest([...known, ...(await fetchBindingReleasesFromGitHub(binding.name, fetch))])
        latestChecked = true
      } catch {
        // The newest release in the built-in table stands in.
      }
    }
    // A minimum names a release, which is the one linked when no newer one is known.
    if (version === null && platform === 'ios') version = pin
  }
  if (version === null) {
    return unresolved(
      `${targetPath} pins ${binding.name} ${pin}, and no release matching it ` +
        `${latestChecked ? 'was found' : 'is in the built-in runtime table'}, ` +
        `so the ${platform} Bare version is unknown`,
      [targetPath]
    )
  }
  const release: PinnedRelease = { pin, version, floating, latestChecked }

  const tableBareKit = binding.bareKits[version] ?? null
  const tableBare = tableBareKit === null ? null : (BARE_KIT_BARE_VERSIONS[tableBareKit] ?? null)
  if (tableBareKit !== null && tableBare !== null) {
    return resolved(platform, tableBare, release, tableBareKit, false)
  }

  const checkedWithoutVersion =
    tableBareKit === null
      ? binding.withoutBareKit.includes(version)
      : BARE_KIT_WITHOUT_BARE.includes(tableBareKit)
  if (checkedWithoutVersion) {
    return unresolved(
      `The Bare version of ${binding.name}@${version} could not be determined: ` +
        (tableBareKit === null
          ? 'its CMakeLists.txt names no bare-kit version'
          : `bare-kit ${tableBareKit} does not name its Bare version in CMakeLists.txt`),
      [targetPath]
    )
  }

  if (!network) {
    return unresolved(
      `${tableBareKit === null ? `${binding.name}@${version}` : `bare-kit ${tableBareKit}`} ` +
        'is not in the built-in runtime table and network lookups are disabled',
      [targetPath]
    )
  }

  onProgress?.(
    `Looking up the Bare version of ${binding.name}@${version} on raw.githubusercontent.com ` +
      `(not in the built-in table, timeout ${NETWORK_TIMEOUT_MS / 1000}s per request)...`
  )

  try {
    const bareKit =
      tableBareKit ?? (await fetchBindingBareKitFromGitHub(binding.name, version, fetch))
    const bare =
      bareKit === null
        ? null
        : (BARE_KIT_BARE_VERSIONS[bareKit] ?? (await fetchBareVersionFromGitHub(bareKit, fetch)))
    if (bareKit !== null && bare !== null) {
      return resolved(platform, bare, release, bareKit, true)
    }
    return unresolved(
      `Could not find the bare-kit or Bare version in the CMakeLists.txt of ${binding.name}@${version}`,
      [targetPath]
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return unresolved(
      `Could not look up the Bare version of ${binding.name}@${version}: ${message}`,
      [targetPath]
    )
  }
}
