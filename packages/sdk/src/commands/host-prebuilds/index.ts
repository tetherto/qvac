import { promises as fsp } from 'node:fs'
import path from 'node:path'
import semver from 'semver'
import type { Logger } from '@/logging/types'
import { createCommandLogger } from '@/commands/command-logger'
import { readAddonPackageJson, type NativeAddon } from '@/commands/verify/addon-source'
import { checkPrebuilds, isMobileHost } from '@/commands/verify/prebuilds'
import {
  checkPackageManagerSupport,
  detectPackageManager,
  installArgs,
  isPackageManagerName,
  runPackageManager,
  type PackageManagerName
} from '@/commands/host-prebuilds/package-manager'
import {
  HostPrebuildsInstallFailedError,
  HostPrebuildsInstallRefusedError
} from '@/utils/errors-client'

export type { PackageManagerName } from '@/commands/host-prebuilds/package-manager'

/** npm's package-name grammar. On Windows the names pass through a shell. */
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

export interface EnsureHostPrebuildsOptions {
  /** The package whose package.json receives the pins; its package manager installs them. */
  projectRoot: string
  /** Bare hosts to cover. Only mobile hosts (`android-*`, `ios-*`) can need an install. */
  hosts: string[]
  /** Addon package names to cover. Defaults to every addon under `<projectRoot>/node_modules`. */
  addons?: string[] | undefined
  /** Install with this package manager instead of detecting the project's own. */
  packageManager?: PackageManagerName | undefined
  quiet?: boolean | undefined
  verbose?: boolean | undefined
}

export interface HostPrebuildPackage {
  /** The platform package, e.g. `@qvac/tts-ggml-android-arm64`. */
  name: string
  /** Always the addon's own version: platform packages are version-locked to it. */
  version: string
  /** The addon the package ships prebuilds for. */
  addon: string
  /** The requested hosts the package covers. */
  hosts: string[]
}

export interface EnsureHostPrebuildsResult {
  /** The packages this call installed; empty when every prebuild already resolved. */
  installed: HostPrebuildPackage[]
  /** The package manager that installed them, or null when nothing was missing. */
  packageManager: PackageManagerName | null
}

/**
 * Installs the per-platform prebuild packages that addons need for mobile
 * hosts and that the project does not have yet.
 *
 * A split addon names one platform package per host in the `#host-addon` map
 * of its package.json (`<addon>-ios` covers every iOS host). Desktop platform
 * packages install as the addon's os/cpu-filtered optionalDependencies, but a
 * build host never reports a mobile os, so mobile ones have to be declared.
 * This declares the missing ones in package.json, pinned to each addon's
 * exact version, using the project's own package manager.
 *
 * A host whose prebuild already resolves is skipped: a local
 * `prebuilds/<host>` in the addon (source builds) or its platform package at
 * the addon's version. Throws `HostPrebuildsInstallRefusedError` when no
 * supported package manager (npm 7+, pnpm, bun, Yarn Berry) is found, and
 * `HostPrebuildsInstallFailedError` when the install does not produce the
 * packages.
 */
export async function ensureHostPrebuilds(options: EnsureHostPrebuildsOptions) {
  const logger = createCommandLogger(options)
  const addons = await resolveAddons(options.projectRoot, options.addons, logger)
  return installMissingHostPrebuilds({
    projectRoot: options.projectRoot,
    hosts: options.hosts,
    addons,
    packageManager: options.packageManager,
    quiet: options.quiet === true,
    logger
  })
}

export interface InstallMissingHostPrebuildsOptions {
  projectRoot: string
  hosts: string[]
  addons: NativeAddon[]
  packageManager?: PackageManagerName | undefined
  quiet: boolean
  logger: Logger
}

/** `ensureHostPrebuilds` for addons the caller has already located. */
export async function installMissingHostPrebuilds(
  options: InstallMissingHostPrebuildsOptions
): Promise<EnsureHostPrebuildsResult> {
  const { projectRoot, hosts, addons, quiet, logger } = options

  const missing = await findMissingHostPrebuilds(addons, hosts)
  if (missing.length === 0) return { installed: [], packageManager: null }

  const dependencies = toDependencies(missing)
  const manager = await choosePackageManager(projectRoot, options.packageManager, dependencies)
  const args = installArgs(
    manager,
    missing.map((pkg) => `${pkg.name}@${pkg.version}`)
  )
  const command = `${manager} ${args.join(' ')}`

  logger.info(`\n📦 Installing addon platform packages with ${manager}:`)
  for (const pkg of missing) {
    logger.info(`   ${pkg.name}@${pkg.version} (${pkg.hosts.join(', ')})`)
  }

  const result = await runPackageManager(manager, args, { cwd: projectRoot, quiet })
  if (result.error !== undefined || result.code !== 0) {
    const outcome = result.error?.message ?? `exited with code ${result.code ?? 'unknown'}`
    const stderr = result.stderr.trim()
    throw new HostPrebuildsInstallFailedError(
      `\`${command}\` ${outcome}${stderr.length > 0 ? `\n\n${stderr}` : ''}`,
      dependencies,
      result.error
    )
  }

  const stillMissing = await findMissingHostPrebuilds(addons, hosts)
  if (stillMissing.length > 0) {
    const names = stillMissing.map((pkg) => pkg.name).join(', ')
    const pnpHint =
      manager === 'yarn'
        ? "; Yarn Plug'n'Play installs no node_modules, so set `nodeLinker: node-modules`"
        : ''
    throw new HostPrebuildsInstallFailedError(
      `\`${command}\` succeeded, but ${names} is still not installed under node_modules${pnpHint}`,
      toDependencies(stillMissing)
    )
  }

  logger.info(`   Installed ${missing.length} platform package${missing.length === 1 ? '' : 's'}`)
  return { installed: missing, packageManager: manager }
}

/**
 * The platform packages `addons` still need for the mobile hosts in `hosts`,
 * one entry per package. Throws when two installed versions of one addon need
 * the same platform package, since only one version of it can be installed.
 */
export async function findMissingHostPrebuilds(addons: NativeAddon[], hosts: string[]) {
  const mobileHosts = hosts.filter(isMobileHost)
  const packages = new Map<string, HostPrebuildPackage>()
  if (mobileHosts.length === 0) return []

  for (const addon of addons) {
    for (const issue of await checkPrebuilds({ addon, hosts: mobileHosts })) {
      const pin = issue.platformPackage
      if (pin === undefined) continue

      const known = packages.get(pin.name)
      if (known === undefined) {
        packages.set(pin.name, { ...pin, addon: addon.name, hosts: [issue.host] })
        continue
      }
      if (known.version !== pin.version) {
        throw new HostPrebuildsInstallRefusedError(
          `${addon.name} is installed at both ${known.version} and ${pin.version}, but ` +
            `${pin.name} can be installed at only one version. ` +
            `Deduplicate ${addon.name} to a single version and try again`,
          {}
        )
      }
      if (!known.hosts.includes(issue.host)) known.hosts.push(issue.host)
    }
  }

  const missing = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))
  for (const pkg of missing) {
    if (!PACKAGE_NAME.test(pkg.name) || semver.valid(pkg.version) === null) {
      throw new HostPrebuildsInstallRefusedError(
        `${pkg.addon} names "${pkg.name}@${pkg.version}", which is not a valid package name and version`,
        {}
      )
    }
  }
  return missing
}

async function choosePackageManager(
  projectRoot: string,
  requested: PackageManagerName | undefined,
  dependencies: Record<string, string>
) {
  let manager: PackageManagerName
  let source = ''
  if (requested !== undefined) {
    if (!isPackageManagerName(requested)) {
      throw new HostPrebuildsInstallRefusedError(
        `packageManager "${String(requested)}" is not npm, pnpm, bun, or yarn`,
        dependencies
      )
    }
    manager = requested
  } else {
    const detected = await detectPackageManager(projectRoot)
    if (detected.manager === null) {
      throw new HostPrebuildsInstallRefusedError(
        `could not tell which package manager the project uses (${detected.reason})`,
        dependencies
      )
    }
    manager = detected.manager
    source = ` (detected from ${detected.source})`
  }

  const unsupported = await checkPackageManagerSupport(manager, projectRoot)
  if (unsupported !== null) {
    throw new HostPrebuildsInstallRefusedError(`${unsupported}${source}`, dependencies)
  }
  return manager
}

/**
 * The installed addons named in `names`, or every installed addon when
 * `names` is omitted. For each name the copy in the nearest modules directory
 * wins, as it does for Node's resolver.
 */
async function resolveAddons(projectRoot: string, names: string[] | undefined, logger: Logger) {
  const moduleDirs = await reachableModuleDirs(projectRoot)
  const wanted = names === undefined ? null : new Set(names)
  const found = new Map<string, NativeAddon>()

  for (const modulesDir of moduleDirs) {
    const candidates = wanted === null ? await listPackageNames(modulesDir) : [...wanted]
    for (const name of candidates) {
      if (found.has(name)) continue
      const result = await readAddonPackageJson({
        packageJsonPath: path.join(modulesDir, ...name.split('/'), 'package.json'),
        expectedName: name
      })
      if (result.addon !== undefined) found.set(name, result.addon)
    }
  }

  for (const name of wanted ?? []) {
    if (!found.has(name)) logger.warn(`${name} is not an installed native addon; skipping it`)
  }
  return [...found.values()]
}

/**
 * Every modules directory a package installed for `projectRoot` can sit in,
 * nearest first: the `node_modules` of the project and of each directory above
 * it (npm, Yarn, and bun hoist workspace dependencies to the root), plus the
 * views pnpm (`.pnpm/node_modules`) and bun's isolated layout
 * (`.bun/node_modules`) keep of the packages that are not direct dependencies.
 */
async function reachableModuleDirs(projectRoot: string) {
  const dirs: string[] = []
  let dir = path.resolve(projectRoot)
  for (;;) {
    const nodeModules = path.join(dir, 'node_modules')
    for (const candidate of [
      nodeModules,
      path.join(nodeModules, '.pnpm', 'node_modules'),
      path.join(nodeModules, '.bun', 'node_modules')
    ]) {
      if (await isDirectory(candidate)) dirs.push(candidate)
    }
    const parent = path.dirname(dir)
    if (parent === dir) return dirs
    dir = parent
  }
}

async function listPackageNames(modulesDir: string) {
  const names: string[] = []
  for (const entry of await readDirNames(modulesDir)) {
    if (entry.startsWith('.')) continue
    if (!entry.startsWith('@')) {
      names.push(entry)
      continue
    }
    for (const scoped of await readDirNames(path.join(modulesDir, entry))) {
      if (!scoped.startsWith('.')) names.push(`${entry}/${scoped}`)
    }
  }
  return names
}

async function readDirNames(dir: string) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

async function isDirectory(dir: string) {
  try {
    return (await fsp.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

function toDependencies(packages: HostPrebuildPackage[]) {
  return Object.fromEntries(packages.map((pkg) => [pkg.name, pkg.version]))
}
