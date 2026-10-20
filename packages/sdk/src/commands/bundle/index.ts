import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import stow from 'bare-stow'
import { DEFAULT_HOSTS, DEFAULT_SDK_NAME } from '@/commands/bundle/constants'
import {
  CONFIG_CANDIDATES,
  resolveConfigForProject
} from '@/client/config-loader/resolve-config.node'
import { createCommandLogger } from '@/commands/command-logger'
import {
  BareImportsMapNotFoundError,
  BundleFailedError,
  BundleVerificationFailedError,
  HostPrebuildsMissingError
} from '@/utils/errors-client'
import { resolvePluginSpecifiers, parseBuiltinSpecifier } from '@/commands/bundle/plugins'
import { generateWorkerEntry } from '@/commands/bundle/entry-gen'
import { createSdkImportResolver, sdkImportsMap } from '@/commands/bundle/resolve-sdk-import'
import {
  AUDIO_DECODER_ADDON,
  listBundledAddonModules,
  listBundledAddons
} from '@/commands/bundle/addons'
import { linkAddons } from '@/commands/bundle/link'
import { assertNodeCanBundle } from '@/commands/bundle/node-support'
import { readBundle } from '@/commands/bundle/read-bundle'
import { TARGETS, type BundleTarget } from '@/commands/bundle/targets'
import {
  findMissingPlatformPackages,
  installMissingHostPrebuilds,
  resolveAddons,
  type HostPrebuildPackage
} from '@/commands/host-prebuilds/index'
import { findInAncestorNodeModules } from '@/expo/plugins/find-in-ancestor-node-modules'
import type { NativeAddon } from '@/commands/verify/addon-source'
import { isMobileHost } from '@/commands/verify/prebuilds'
import { formatVerifyBundleResult, verifyBundle } from '@/commands/verify/index'
import { formatRuntimeSource } from '@/commands/verify/abi'
import { formatEnginesAdvice } from '@/commands/verify/engines-advice'
import type { Logger } from '@/logging/types'

export interface BundleSdkOptions {
  projectRoot?: string | undefined
  configPath?: string | undefined
  sdkPath?: string | undefined
  /** Where the worker runs. Defaults to `bare-sidecar`. */
  target?: BundleTarget | undefined
  /**
   * Hosts to bundle for. Defaults to this machine for `bare-sidecar` and
   * `pear-runtime`, and to every phone host for `react-native`.
   */
  hosts?: string[] | undefined
  defer?: string[] | undefined
  quiet?: boolean | undefined
  verbose?: boolean | undefined
  /**
   * Install the addon platform packages that the split addons the bundle
   * reaches need for its mobile hosts, with the project's package manager
   * (see `ensureHostPrebuilds`), before bundling. Off by default: without it,
   * bundling never changes package.json or node_modules. A host whose
   * platform package is missing fails with `HostPrebuildsMissingError`,
   * naming the exact pins; desktop packages are never installed. A refused
   * install throws `HostPrebuildsInstallRefusedError` before anything is
   * written.
   */
  installMissingPrebuilds?: boolean | undefined
  /**
   * Run `verifyBundle` on the bundle and fail with
   * `BundleVerificationFailedError` on its errors. An engines.bare mismatch
   * against the Bare runtime in react-native-bare-kit only warns. Defaults to
   * true; callers that run `verifyBundle` on the result can turn it off.
   */
  verify?: boolean | undefined
  /** Allow network lookups during verification. Defaults to true. */
  network?: boolean | undefined
  /**
   * For the `react-native` target, link the native addons for the phone hosts
   * into react-native-bare-kit. Defaults to true.
   */
  link?: boolean | undefined
}

export interface BundleSdkResult {
  target: BundleTarget
  hosts: string[]
  /** The generated worker entry the bundle starts from. */
  entryPath: string
  /** The bare-stow harness that starts the bundled worker. */
  harnessPath: string
  bundlePath: string
  plugins: string[]
  addons: string[]
  addonModules: string[]
  /** Platform packages `installMissingPrebuilds` installed; empty when it is off. */
  installedPrebuilds: HostPrebuildPackage[]
  /** Paths the link step wrote. */
  linked: string[]
}

function resolveSdkPath(projectRoot: string, explicitSdkPath?: string): string {
  if (explicitSdkPath) {
    return path.isAbsolute(explicitSdkPath)
      ? explicitSdkPath
      : path.join(projectRoot, explicitSdkPath)
  }

  return (
    findInAncestorNodeModules(projectRoot, DEFAULT_SDK_NAME) ??
    path.join(projectRoot, 'node_modules', DEFAULT_SDK_NAME)
  )
}

function realpath(dir: string): string {
  try {
    return fs.realpathSync(dir)
  } catch {
    return dir
  }
}

async function resolveSdkName(sdkPath: string): Promise<string> {
  const sdkPackageJsonPath = path.join(sdkPath, 'package.json')

  try {
    if (fs.existsSync(sdkPackageJsonPath)) {
      const content = await fsp.readFile(sdkPackageJsonPath, 'utf8')
      const pkg = JSON.parse(content) as { name?: string }
      if (pkg.name) return pkg.name
    }
  } catch {
    // Fall through to default
  }

  return DEFAULT_SDK_NAME
}

function resolveImportsMapPath(sdkPath: string, sdkName: string): string {
  const importsMapPath = path.join(sdkPath, 'bare-imports.json')

  if (fs.existsSync(importsMapPath)) {
    return importsMapPath
  }

  throw new BareImportsMapNotFoundError(sdkName, importsMapPath)
}

interface VerifyOutputOptions {
  projectRoot: string
  bundlePath: string
  hosts: string[]
  network: boolean | undefined
  logger: Logger
}

const ENGINES_ISSUE_CODES = new Set(['abi-mismatch', 'engines-mismatch'])
const AUDIO_PLUGINS = new Set([
  'whispercpp-transcription',
  'bci-whispercpp-transcription',
  'parakeet-transcription',
  'moss-transcribe',
  'audiogen-ggml'
])

function audioPluginsIn(pluginSpecifiers: string[], sdkName: string): string[] {
  return pluginSpecifiers.filter((specifier) => {
    const builtin = parseBuiltinSpecifier(specifier, sdkName)
    return builtin !== null && AUDIO_PLUGINS.has(builtin.suffix)
  })
}

async function verifyOutput(options: VerifyOutputOptions) {
  const { projectRoot, bundlePath, hosts, network, logger } = options

  logger.info('\n🔎 Verifying the bundle...')
  const result = await verifyBundle({
    projectRoot,
    addonsSource: bundlePath,
    hosts,
    ...(network !== undefined ? { network } : {}),
    onProgress: (message) => logger.info(`   ${message}`)
  })

  const blocking = result.issues.filter(
    (issue) => issue.level === 'error' && !ENGINES_ISSUE_CODES.has(issue.code)
  )
  if (blocking.length > 0) {
    throw new BundleVerificationFailedError(
      bundlePath,
      new Error(formatVerifyBundleResult({ ...result, issues: blocking }))
    )
  }

  const label = hosts.join(', ')
  if (result.runtime === null) return
  if (!result.runtime.resolved) {
    logger.warn(`engines.bare not checked for ${label}: ${result.runtime.error.reason}`)
    return
  }
  logger.info(
    `   ${label}: Bare ${result.runtime.runtime.version} (from ${formatRuntimeSource(result.runtime.runtime)})`
  )

  const mismatches = result.issues.filter(
    (issue) => ENGINES_ISSUE_CODES.has(issue.code) && issue.level === 'error'
  )
  if (mismatches.length === 0) {
    logger.info(`   No engines.bare mismatches for ${label}`)
    return
  }

  const lines = ['The bundle contains packages that require a newer Bare runtime:']
  for (const issue of mismatches) lines.push(`  - ${issue.message}`)
  lines.push('')
  if (result.advice !== undefined) lines.push(...formatEnginesAdvice(result.advice))
  logger.warn(lines.join('\n').trimEnd())
}

function defaultHosts(target: BundleTarget): string[] {
  if (target === 'react-native') return DEFAULT_HOSTS.filter(isMobileHost)
  return [`${process.platform}-${process.arch}`]
}

type ImportsMap = NonNullable<stow.StowOptions['imports']>

interface StowBundleOptions {
  projectRoot: string
  entryPath: string
  target: BundleTarget
  outputDir: string
  hosts: string[]
  imports: ImportsMap
  deferModules: string[]
}

/** Writes the bundle, the harness and the files the bundle loads, and returns the bundle's path. */
async function stowBundle(options: StowBundleOptions): Promise<string> {
  const { projectRoot, entryPath, target, outputDir, hosts, imports, deferModules } = options
  const spec = TARGETS[target]
  const harnessPath = path.join(outputDir, spec.harness)
  const stowTarget = await spec.load(projectRoot)

  assertNodeCanBundle()
  await fsp.rm(outputDir, { recursive: true, force: true })

  // With no base, bare-stow keys the bundle from the closest folder holding
  // every module.
  const stowOptions: stow.StowOptions = { imports, defer: deferModules, hosts }

  const written: string[] = []
  try {
    for await (const artifact of stow(
      pathToFileURL(entryPath).href,
      stowTarget,
      pathToFileURL(harnessPath).href,
      stowOptions
    )) {
      written.push(fileURLToPath(artifact.url.href))
    }
  } catch (error) {
    throw new BundleFailedError(entryPath, error)
  }

  const bundlePath = written.find(
    (file) => path.dirname(file) === outputDir && file !== harnessPath && !file.endsWith('.d.ts')
  )
  if (bundlePath === undefined) {
    throw new BundleFailedError(entryPath, new Error(`bare-stow wrote no bundle to ${outputDir}`))
  }
  return bundlePath
}

export function bundleSdk(options: BundleSdkOptions = {}): Promise<BundleSdkResult> {
  return bundle(options, false)
}

// Only for the CI resource collector check, which bundles every desktop host on
// one runner that has only its own hosts' platform packages. Not public API.
export function bundleSdkDeferringMissingPlatformPackages(
  options: BundleSdkOptions
): Promise<BundleSdkResult> {
  return bundle(options, true)
}

async function bundle(
  options: BundleSdkOptions,
  deferMissingPlatformPackages: boolean
): Promise<BundleSdkResult> {
  const startTime = Date.now()

  const projectRoot = path.resolve(options.projectRoot ?? process.cwd())
  const qvacDir = path.join(projectRoot, 'qvac')
  const outputDir = path.join(qvacDir, 'worker')
  const entryPath = path.join(qvacDir, 'worker.entry.mjs')
  const target = options.target ?? 'bare-sidecar'

  const logger = createCommandLogger(options)

  logger.info('🔧 QVAC SDK Worker Bundler\n')

  const { configPath, config } = await resolveConfigForProject(projectRoot, options.configPath)

  if (configPath) {
    logger.info(`📄 Config: ${path.relative(projectRoot, configPath)}`)
  } else {
    logger.info('📄 Config: (none)')
    logger.warn('No config file found — continuing with defaults.')
    logger.info(
      '   To customize bundling, create one of:\n' +
        CONFIG_CANDIDATES.map((c) => `     - ${c}`).join('\n') +
        '\n'
    )
  }

  const sdkPath = realpath(resolveSdkPath(projectRoot, options.sdkPath))
  const sdkName = await resolveSdkName(sdkPath)
  logger.info(`📦 SDK: ${sdkName}`)
  logger.debug(`   Path: ${sdkPath}`)

  const importsMapPath = resolveImportsMapPath(sdkPath, sdkName)
  const imports = JSON.parse(await fsp.readFile(importsMapPath, 'utf8')) as ImportsMap

  // An SDK the project installs is imported by name. One outside the project is
  // imported by its real path, and so is its bare-stow runtime, which the
  // generated shim imports.
  const installedSdk = findInAncestorNodeModules(projectRoot, sdkName)
  const sdkByName = installedSdk !== null && realpath(installedSdk) === sdkPath
  const resolveImport = sdkByName ? undefined : createSdkImportResolver(sdkPath, sdkName)
  if (!sdkByName) {
    const sdkRequire = createRequire(path.join(sdkPath, 'package.json'))
    Object.assign(imports, sdkImportsMap(sdkPath, sdkName))
    imports['bare-stow/runtime'] = pathToFileURL(sdkRequire.resolve('bare-stow/runtime')).href
  }

  const pluginSpecifiers = resolvePluginSpecifiers(config, sdkName, logger)
  logger.info(`\n📦 Plugins to include (${pluginSpecifiers.length}):`)
  for (const spec of pluginSpecifiers) {
    const label = parseBuiltinSpecifier(spec, sdkName) ? '✓ built-in' : '⊕ custom'
    logger.info(`   ${label}: ${spec}`)
  }

  const hosts = options.hosts && options.hosts.length > 0 ? options.hosts : defaultHosts(target)

  const explicitDefer = options.defer ?? []
  const includeAudioDecoder =
    config.includeAudioDecoder !== false && !explicitDefer.includes(AUDIO_DECODER_ADDON)
  const deferModules = includeAudioDecoder
    ? explicitDefer
    : [...new Set([...explicitDefer, AUDIO_DECODER_ADDON])]

  if (!includeAudioDecoder) {
    const affected = audioPluginsIn(pluginSpecifiers, sdkName)
    if (affected.length > 0) {
      logger.warn(
        `${AUDIO_DECODER_ADDON} is not bundled: ${affected.join(', ')} cannot decode compressed audio files; compressed audiogen output formats also require FFmpeg.`
      )
    }
  }

  await fsp.mkdir(qvacDir, { recursive: true })

  logger.info('\n📝 Generating worker entry...')
  await fsp.writeFile(
    entryPath,
    generateWorkerEntry(pluginSpecifiers, sdkName, config.rpcServerProvider, resolveImport),
    'utf8'
  )
  logger.info(`   Created: ${path.relative(projectRoot, entryPath)}`)

  logger.info(`\n🔨 Bundling for ${target}...`)
  logger.debug(`   Hosts: ${hosts.join(', ')}`)
  if (deferModules.length > 0) {
    logger.debug(`   Deferred: ${deferModules.join(', ')}`)
  }

  const stowOptions = { projectRoot, entryPath, target, outputDir, hosts, imports, deferModules }

  const addonsMissingPlatformPackages = () =>
    reachedAddonsMissingPlatformPackages({
      addons: async () =>
        (await resolveAddons(projectRoot, undefined, logger)).filter(
          (addon) => !deferModules.includes(addon.name)
        ),
      hosts,
      scan: async (extraDefer) => {
        const scanDir = path.join(qvacDir, 'worker.scan')
        try {
          const bundlePath = await stowBundle({
            ...stowOptions,
            outputDir: scanDir,
            deferModules: [...deferModules, ...extraDefer]
          })
          return (await readBundle(bundlePath)).resolutions
        } finally {
          await fsp.rm(scanDir, { recursive: true, force: true })
        }
      },
      logger
    })

  let installedPrebuilds: HostPrebuildPackage[] = []
  let bundleDefer = deferModules
  const missingPlatformAddons = await addonsMissingPlatformPackages()
  if (deferMissingPlatformPackages) {
    const missing = await findMissingPlatformPackages(missingPlatformAddons, hosts)
    bundleDefer = [...deferModules, ...missing.map((pkg) => pkg.name)]
  } else if (options.installMissingPrebuilds === true) {
    const { installed } = await installMissingHostPrebuilds({
      projectRoot,
      hosts,
      addons: missingPlatformAddons,
      quiet: options.quiet === true,
      logger
    })
    installedPrebuilds = installed
    await throwIfPlatformPackagesMissing(
      missingPlatformAddons,
      hosts.filter((host) => !isMobileHost(host))
    )
  } else {
    await throwIfPlatformPackagesMissing(missingPlatformAddons, hosts)
  }

  const bundlePath = await stowBundle({ ...stowOptions, deferModules: bundleDefer })

  const stats = await fsp.stat(bundlePath)
  const sizeKB = (stats.size / 1024).toFixed(1)
  logger.info(`\n✅ Bundle created: ${path.relative(projectRoot, bundlePath)}`)
  logger.info(`   Size: ${sizeKB} KB`)

  const addons = await listBundledAddons({ bundlePath, projectRoot, logger, includeAudioDecoder })
  const addonModules = await listBundledAddonModules({
    bundlePath,
    projectRoot,
    logger,
    includeAudioDecoder
  })
  logger.info(`   Native addons (${addons.length}): ${addons.join(', ') || '(none)'}`)

  if (options.verify !== false) {
    await verifyOutput({
      projectRoot,
      bundlePath,
      hosts,
      network: options.network,
      logger
    })
  }

  let linked: string[] = []
  if (target === 'react-native' && options.link !== false) {
    logger.info('\n🔗 Linking native addons into react-native-bare-kit...')
    linked = await linkAddons({ projectRoot, addonModules, hosts, logger })
    logger.info(`   Wrote ${linked.length} files`)
  }

  const harnessPath = path.join(outputDir, TARGETS[target].harness)
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
  logger.info(`\n🎉 Done in ${elapsed}s!\n`)
  logger.info('Generated files:')
  logger.info(`  - ${path.relative(projectRoot, entryPath)}    (worker entry)`)
  logger.info(`  - ${path.relative(projectRoot, harnessPath)}    (starts the bundled worker)`)
  logger.info(`  - ${path.relative(projectRoot, bundlePath)}\n`)

  return {
    target,
    hosts,
    entryPath,
    harnessPath,
    bundlePath,
    plugins: pluginSpecifiers,
    addons,
    addonModules,
    installedPrebuilds,
    linked
  }
}

interface ReachedAddonsOptions {
  addons: () => Promise<NativeAddon[]>
  hosts: string[]
  /** Bundles with these extra modules deferred and returns the bundle's resolutions. */
  scan: (extraDefer: string[]) => Promise<unknown>
  logger: Logger
}

/**
 * The installed split addons that the bundle reaches and that are missing a
 * platform package for one of the hosts. Every installed addon is a candidate (`@qvac/sdk`
 * depends on all of them), so a first bundling pass defers each missing
 * platform package: the bundle then records the reached ones as
 * `deferred:<package>` and never visits the rest. Empty when nothing is
 * missing, or when that pass fails, which leaves the real bundle to report
 * the failure.
 */
async function reachedAddonsMissingPlatformPackages(
  options: ReachedAddonsOptions
): Promise<NativeAddon[]> {
  const { hosts, scan, logger } = options
  const addons = await options.addons()
  const missing = await findMissingPlatformPackages(addons, hosts)
  if (missing.length === 0) return []

  logger.debug(
    `\n🔎 Checking which of ${missing.length} missing platform packages the bundle reaches...`
  )
  try {
    const reached = deferredSpecifiers(await scan(missing.map((pkg) => pkg.name)))
    const owners = new Set(missing.filter((pkg) => reached.has(pkg.name)).map((pkg) => pkg.addon))
    return addons.filter((addon) => owners.has(addon.name))
  } catch (error: unknown) {
    logger.debug(`   Scan failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

const DEFERRED_PROTOCOL = 'deferred:'

/** Every specifier a bundle leaves as `deferred:<specifier>`. */
function deferredSpecifiers(resolutions: unknown): Set<string> {
  const found = new Set<string>()
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      if (value.startsWith(DEFERRED_PROTOCOL)) found.add(value.slice(DEFERRED_PROTOCOL.length))
    } else if (value !== null && typeof value === 'object') {
      for (const nested of Object.values(value)) visit(nested)
    }
  }
  visit(resolutions)
  return found
}

/**
 * Throws `HostPrebuildsMissingError` when split addons are missing platform
 * packages for `hosts`, naming the exact pins.
 */
async function throwIfPlatformPackagesMissing(addons: NativeAddon[], hosts: string[]) {
  let missing: HostPrebuildPackage[]
  try {
    missing = await findMissingPlatformPackages(addons, hosts)
  } catch {
    return
  }
  if (missing.length === 0) return
  throw new HostPrebuildsMissingError(
    Object.fromEntries(missing.map((pkg) => [pkg.name, pkg.version]))
  )
}
