import { promises as fsp } from 'node:fs'
import path from 'node:path'
import semver from 'semver'
import {
  BARE_KIT_BARE_VERSIONS,
  REACT_NATIVE_BARE_KIT_RUNTIMES
} from '@/commands/verify/bare-kit-runtimes'
import { findInAncestorNodeModules } from '@/expo/plugins/find-in-ancestor-node-modules'
import type { BareRuntimeResolution } from '@/commands/verify/abi'

export const REACT_NATIVE_BARE_KIT = 'react-native-bare-kit'

export const NETWORK_TIMEOUT_MS = 5000

const RAW_GITHUB_BASE = 'https://raw.githubusercontent.com/holepunchto'

const MOBILE_PLATFORMS = new Set(['android', 'ios'])

/**
 * The iOS framework ships inside the npm package, and its bundle version is
 * the bare-kit release it was built from, so it identifies the embedded
 * runtime without a network request.
 */
const BARE_KIT_INFO_PLIST = path.join(
  'ios',
  'BareKit.xcframework',
  'ios-arm64',
  'BareKit.framework',
  'Info.plist'
)

export type FetchText = (url: string) => Promise<string>

export type ProgressFn = (message: string) => void

export interface ResolveMobileBareRuntimeOptions {
  projectRoot: string
  network?: boolean | undefined
  onProgress?: ProgressFn | undefined
  fetchText?: FetchText | undefined
}

export function isMobileHost(host: string) {
  return MOBILE_PLATFORMS.has(host.split('-')[0] ?? host)
}

export function isReactNativeBareKitInstalled(projectRoot: string) {
  return findInAncestorNodeModules(projectRoot, REACT_NATIVE_BARE_KIT) !== null
}

export async function fetchText(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`)
  return response.text()
}

export function parseBareKitReleaseVersion(cmakeLists: string) {
  const match = /holepunchto\/bare-kit\/releases\/download\/v(\d+\.\d+\.\d+[^/"\s]*)\//.exec(
    cmakeLists
  )
  return match?.[1] ?? null
}

export function parseBareVersion(cmakeLists: string) {
  const match = /fetch_package\(\s*"github:holepunchto\/bare@(\d+\.\d+\.\d+[^"\s]*)"/.exec(
    cmakeLists
  )
  return match?.[1] ?? null
}

export function parseInfoPlistVersion(plist: string) {
  const match =
    /<key>CFBundleShortVersionString<\/key>\s*<string>(\d+\.\d+\.\d+[^<]*)<\/string>/.exec(plist)
  return match?.[1] ?? null
}

export async function fetchBareKitVersionFromGitHub(
  reactNativeBareKitVersion: string,
  fetch: FetchText = fetchText
) {
  const cmakeLists = await fetch(
    `${RAW_GITHUB_BASE}/${REACT_NATIVE_BARE_KIT}/v${reactNativeBareKitVersion}/CMakeLists.txt`
  )
  return parseBareKitReleaseVersion(cmakeLists)
}

export async function fetchBareVersionFromGitHub(
  bareKitVersion: string,
  fetch: FetchText = fetchText
) {
  const cmakeLists = await fetch(`${RAW_GITHUB_BASE}/bare-kit/v${bareKitVersion}/CMakeLists.txt`)
  return parseBareVersion(cmakeLists)
}

export function bareVersionForBareKit(bareKitVersion: string) {
  return BARE_KIT_BARE_VERSIONS[bareKitVersion] ?? null
}

function newestKey(record: Record<string, unknown>) {
  const versions = Object.keys(record).filter((version) => semver.valid(version) !== null)
  return versions.length === 0 ? null : versions.sort(semver.rcompare)[0]!
}

/**
 * The table generator has already probed every release up to the newest
 * entry, so only newer releases can have data on GitHub that the table lacks.
 */
function isNewerThanTable(version: string, record: Record<string, unknown>) {
  const newest = newestKey(record)
  return newest === null || semver.valid(version) === null || semver.gt(version, newest)
}

/**
 * The oldest react-native-bare-kit release newer than `currentVersion` whose
 * embedded Bare satisfies every range, or null if the table has none.
 */
export function findReactNativeBareKitUpgrade(currentVersion: string, ranges: string[]) {
  const candidates = Object.entries(REACT_NATIVE_BARE_KIT_RUNTIMES)
    .filter(([version]) => semver.valid(version) !== null && semver.prerelease(version) === null)
    .sort(([a], [b]) => semver.compare(a, b))

  for (const [version, runtime] of candidates) {
    if (semver.valid(currentVersion) !== null && !semver.gt(version, currentVersion)) continue
    if (ranges.every((range) => semver.satisfies(runtime.bare, range))) {
      return { version, bareKit: runtime.bareKit, bare: runtime.bare }
    }
  }
  return null
}

async function readJsonVersion(packageJsonPath: string) {
  try {
    const parsed = JSON.parse(await fsp.readFile(packageJsonPath, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

async function readInfoPlistVersion(packageDir: string) {
  try {
    return parseInfoPlistVersion(
      await fsp.readFile(path.join(packageDir, BARE_KIT_INFO_PLIST), 'utf8')
    )
  } catch {
    return null
  }
}

function resolved(
  version: string,
  reactNativeBareKitVersion: string,
  bareKitVersion: string,
  via: 'table' | 'info-plist' | 'github'
): BareRuntimeResolution {
  return {
    resolved: true,
    runtime: {
      version,
      source: 'react-native-bare-kit',
      packageVersion: reactNativeBareKitVersion,
      detail:
        `react-native-bare-kit@${reactNativeBareKitVersion} embeds bare-kit ${bareKitVersion}` +
        (via === 'github' ? ', looked up on GitHub' : '')
    }
  }
}

/**
 * Bare version the app runs on mobile: the one compiled into the bare-kit
 * binaries that react-native-bare-kit ships, not any `bare-runtime` package
 * in node_modules.
 *
 * Checks the built-in table, then the installed iOS framework's Info.plist,
 * and only then GitHub.
 */
export async function resolveMobileBareRuntime(
  options: ResolveMobileBareRuntimeOptions
): Promise<BareRuntimeResolution> {
  const { projectRoot, network = true, onProgress, fetchText: fetch = fetchText } = options

  const packageDir = findInAncestorNodeModules(projectRoot, REACT_NATIVE_BARE_KIT)
  if (packageDir === null) {
    return {
      resolved: false,
      error: {
        reason: `${REACT_NATIVE_BARE_KIT} is not installed, so the mobile Bare version is unknown`,
        triedPaths: [path.join(projectRoot, 'node_modules', REACT_NATIVE_BARE_KIT)]
      }
    }
  }

  const packageJsonPath = path.join(packageDir, 'package.json')
  const version = await readJsonVersion(packageJsonPath)
  if (version === null) {
    return {
      resolved: false,
      error: {
        reason: `Could not read the version of ${REACT_NATIVE_BARE_KIT}`,
        triedPaths: [packageJsonPath]
      }
    }
  }

  const known = REACT_NATIVE_BARE_KIT_RUNTIMES[version]
  if (known !== undefined) return resolved(known.bare, version, known.bareKit, 'table')

  let bareKitVersion = await readInfoPlistVersion(packageDir)
  if (bareKitVersion !== null) {
    const bare = bareVersionForBareKit(bareKitVersion)
    if (bare !== null) return resolved(bare, version, bareKitVersion, 'info-plist')
  }

  const canLookUp =
    bareKitVersion === null
      ? isNewerThanTable(version, REACT_NATIVE_BARE_KIT_RUNTIMES)
      : isNewerThanTable(bareKitVersion, BARE_KIT_BARE_VERSIONS)
  if (!canLookUp) {
    return {
      resolved: false,
      error: {
        reason:
          `The Bare version of ${REACT_NATIVE_BARE_KIT}@${version} could not be determined: ` +
          (bareKitVersion === null
            ? 'the release does not record its bare-kit version and its iOS framework Info.plist could not be read'
            : `bare-kit ${bareKitVersion} does not name its Bare version in CMakeLists.txt`),
        triedPaths: [packageJsonPath, path.join(packageDir, BARE_KIT_INFO_PLIST)]
      }
    }
  }

  if (!network) {
    return {
      resolved: false,
      error: {
        reason:
          `${REACT_NATIVE_BARE_KIT}@${version} is not in the built-in runtime table ` +
          'and network lookups are disabled',
        triedPaths: [packageJsonPath]
      }
    }
  }

  onProgress?.(
    `Looking up the Bare version embedded in ${REACT_NATIVE_BARE_KIT}@${version} on ` +
      `raw.githubusercontent.com (not in the built-in table, timeout ${NETWORK_TIMEOUT_MS / 1000}s per request)...`
  )

  try {
    if (bareKitVersion === null) {
      bareKitVersion = await fetchBareKitVersionFromGitHub(version, fetch)
    }
    const bare =
      bareKitVersion === null
        ? null
        : (bareVersionForBareKit(bareKitVersion) ??
          (await fetchBareVersionFromGitHub(bareKitVersion, fetch)))
    if (bareKitVersion !== null && bare !== null) {
      return resolved(bare, version, bareKitVersion, 'github')
    }
    return {
      resolved: false,
      error: {
        reason: `Could not find the bare-kit or Bare version in the CMakeLists.txt of ${REACT_NATIVE_BARE_KIT}@${version}`,
        triedPaths: [packageJsonPath]
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      resolved: false,
      error: {
        reason: `Could not look up the Bare version of ${REACT_NATIVE_BARE_KIT}@${version}: ${message}`,
        triedPaths: [packageJsonPath]
      }
    }
  }
}
