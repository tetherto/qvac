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
import { assertReactNativeBareKitSupported, stageAddons } from '@/commands/bundle/link'
import { assertNodeCanBundle } from '@/commands/bundle/node-support'
import { readBundle } from '@/commands/bundle/read-bundle'
import {
  discardScratch,
  discardStaged,
  removeStaleScratch,
  replaceAll,
  scratchFolderFor,
  type Staged
} from '@/commands/bundle/scratch'
import {
  HARNESS_FILE,
  TARGETS,
  type BundleLanguage,
  type BundleTarget
} from '@/commands/bundle/targets'
import {
  findMissingPlatformPackages,
  installMissingHostPrebuilds,
  resolveAddons,
  type HostPrebuildPackage
} from '@/commands/host-prebuilds/index'
import { findInAncestorNodeModules } from '@/expo/plugins/find-in-ancestor-node-modules'
import type { NativeAddon } from '@/commands/verify/addon-source'
import { isMobileHost } from '@/commands/verify/prebuilds'
import {
  DESKTOP_RUNTIMES,
  formatVerifyBundleResult,
  hasErrors,
  verifyBundle,
  type VerifyBundleResult
} from '@/commands/verify/index'
import { formatRuntimeSource } from '@/commands/verify/abi'
import { formatEnginesAdvice } from '@/commands/verify/engines-advice'
import { BUNDLED_SDK_VERSION_FIELD, BUNDLED_TARGET_FIELD } from '@/client/rpc/bundle-stamp'
import type { Logger } from '@/logging/types'

export interface BundleSdkOptions {
  projectRoot?: string | undefined
  configPath?: string | undefined
  sdkPath?: string | undefined
  /** Where the worker runs. Defaults to `bare-sidecar`. */
  target?: BundleTarget | undefined
  /**
   * The language of the app that starts the worker, which bare-stow writes
   * the harness package in: `javascript`, `kotlin` for `bare-kit`, or `python`
   * for `bare-sidecar`. Defaults to `kotlin` for `bare-kit` and `javascript`
   * otherwise.
   */
  language?: BundleLanguage | undefined
  /** bare-stow's options for the language, such as `{ package }` for `kotlin`. */
  languageOptions?: Record<string, string> | undefined
  /**
   * The folder bare-stow writes the harness package to, which must be empty or
   * not exist yet. Defaults to `qvac/worker/`, which each bundle replaces.
   */
  outputDir?: string | undefined
  /**
   * Hosts to bundle for. Defaults to this machine for `bare-sidecar` and
   * `pear-runtime`, to every phone host for `react-native`, and to the
   * Android hosts for `bare-kit`.
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
   * install throws `HostPrebuildsInstallRefusedError` before `qvac/worker/`
   * changes.
   */
  installMissingPrebuilds?: boolean | undefined
  /**
   * Run `verifyBundle` on the bundle before it replaces the previous one, and
   * fail with `BundleVerificationFailedError` on its errors, leaving the
   * previous bundle and native modules in place. Defaults to true.
   */
  verify?: boolean | undefined
  /** Allow network lookups during verification. Defaults to true. */
  network?: boolean | undefined
  /**
   * For the `react-native` target, write Bare Kit and the native addons the
   * worker loads into `android/qvac-bare-kit` and `ios/QvacBareKit`, which the
   * app's native projects build. True links every bundled phone host, and a
   * list links only those hosts. Defaults to true.
   */
  link?: boolean | string[] | undefined
}

export interface BundleSdkResult {
  target: BundleTarget
  hosts: string[]
  language: BundleLanguage
  /** The generated worker entry the bundle starts from. */
  entryPath: string
  /** bare-stow's harness package: the module that starts the worker, its manifest and the bundle. */
  outputDir: string
  bundlePath: string
  plugins: string[]
  addons: string[]
  addonModules: string[]
  /** Platform packages `installMissingPrebuilds` installed; empty when it is off. */
  installedPrebuilds: HostPrebuildPackage[]
  /** Paths the link step wrote. */
  linked: string[]
  /** What `verify` found; null when it was turned off. */
  verification: VerifyBundleResult | null
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
  target: BundleTarget
  network: boolean | undefined
  logger: Logger
}

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

/**
 * The bare-stow this command bundles and links with, whose Bare Kit pins are
 * the phone runtimes, even when the project installs another SDK.
 */
function bundlerBareStowDir(): string {
  return path.dirname(createRequire(import.meta.url).resolve('bare-stow/package'))
}

async function verifyOutput(options: VerifyOutputOptions): Promise<VerifyBundleResult> {
  const { projectRoot, bundlePath, hosts, target, network, logger } = options

  logger.info('\n🔎 Verifying the bundle...')
  const result = await verifyBundle({
    projectRoot,
    addonsSource: bundlePath,
    hosts,
    bareStowDir: bundlerBareStowDir(),
    desktopRuntime: DESKTOP_RUNTIMES[target],
    ...(network !== undefined ? { network } : {}),
    onProgress: (message) => logger.info(`   ${message}`)
  })

  if (hasErrors(result)) {
    throw new BundleVerificationFailedError(bundlePath, new Error(formatVerifyBundleResult(result)))
  }

  const checked: string[] = []
  for (const { hosts: platformHosts, resolution } of result.runtimes) {
    const label = platformHosts.join(', ')
    if (!resolution.resolved) {
      logger.warn(`engines.bare not checked for ${label}: ${resolution.error.reason}`)
      continue
    }
    logger.info(
      `   ${label}: Bare ${resolution.runtime.version} (from ${formatRuntimeSource(resolution.runtime)})`
    )
    checked.push(...platformHosts)
  }
  if (checked.length === 0) return result

  const mismatches = result.issues.filter((issue) => issue.code === 'engines-mismatch')
  if (mismatches.length === 0) {
    logger.info(`   No engines.bare mismatches for ${checked.join(', ')}`)
    return result
  }

  const lines = ['The bundle contains packages that declare a newer Bare runtime:']
  for (const issue of mismatches) lines.push(`  - ${issue.message}`)
  lines.push('')
  for (const advice of result.advice) lines.push(...formatEnginesAdvice(advice))
  logger.warn(lines.join('\n').trimEnd())
  return result
}

function defaultHosts(target: BundleTarget): string[] {
  if (target === 'react-native') return DEFAULT_HOSTS.filter(isMobileHost)
  if (target === 'bare-kit') return DEFAULT_HOSTS.filter((host) => host.startsWith('android-'))
  return [`${process.platform}-${process.arch}`]
}

type ImportsMap = NonNullable<stow.StowOptions['imports']>

interface StowBundleOptions {
  projectRoot: string
  entryPath: string
  target: BundleTarget
  language: BundleLanguage
  languageOptions: Record<string, string>
  outputDir: string
  hosts: string[]
  imports: ImportsMap
  deferModules: string[]
}

/** Writes bare-stow's harness package for the target to `outputDir`, and returns the bundle's path. */
async function stowBundle(options: StowBundleOptions): Promise<string> {
  const { projectRoot, entryPath, target, language, outputDir, hosts, imports, deferModules } =
    options
  const stowTarget = await TARGETS[target].load(projectRoot)

  assertNodeCanBundle()

  // With no base, bare-stow keys the bundle from the closest folder holding
  // every module.
  const stowOptions: stow.StowOptions = {
    imports,
    defer: deferModules,
    hosts,
    language,
    languageOptions: options.languageOptions
  }

  let bundlePath: string | undefined
  try {
    for await (const artifact of stow(
      pathToFileURL(entryPath).href,
      stowTarget,
      pathToFileURL(outputDir).href,
      stowOptions
    )) {
      if (artifact.base !== undefined) bundlePath = fileURLToPath(artifact.url.href)
    }
  } catch (error) {
    throw new BundleFailedError(entryPath, describeMissingAddonBuild(error, hosts) ?? error)
  }

  if (bundlePath === undefined) {
    throw new BundleFailedError(entryPath, new Error(`bare-stow wrote no bundle to ${outputDir}`))
  }
  if (language === 'javascript') await assertHarnessDependenciesResolve(entryPath, outputDir)
  return bundlePath
}

const PACKAGE_IN_PATH = /\/node_modules\/((?:@[^/]+\/)?[^/]+)(?=\/)/g
const MISSING_FOR_HOSTS = /for hosts? ((?:'[^']+'(?:, )?)+)/

/**
 * The addon package and hosts an `ADDON_NOT_FOUND` from the bundler names, in
 * place of its list of candidate paths, or null for any other error. The error
 * names the hosts only when some of `hosts` have a build.
 */
export function describeMissingAddonBuild(error: unknown, hosts: string[]): Error | null {
  const { code, referrer, message } = (error ?? {}) as {
    code?: unknown
    referrer?: { href: string } | null
    message?: unknown
  }
  if (code !== 'ADDON_NOT_FOUND' || !referrer) return null

  const owner = [...referrer.href.matchAll(PACKAGE_IN_PATH)].at(-1)?.[1]
  if (owner === undefined) return null
  const named = typeof message === 'string' ? MISSING_FOR_HOSTS.exec(message)?.[1] : undefined
  const missing = named === undefined ? hosts : [...named.matchAll(/'([^']+)'/g)].map((m) => m[1]!)

  return new Error(
    `${owner} has no native build for ${missing.join(', ')}. Bundle for the hosts it ships ` +
      'builds for, or leave it out of the bundle with `defer`.',
    { cause: error }
  )
}

/** Records the bundling SDK's version in the harness package.json, where the desktop client checks it. */
/** Files an older `@qvac/sdk` wrote into `qvac/`, which nothing reads now. */
const STALE_QVAC_FILES = ['worker.bundle.js', 'addons.manifest.json']

/** Records the SDK version and the target in the harness package.json, for the client to check. */
async function stampBundle(harnessDir: string, sdkPath: string, target: BundleTarget) {
  const sdk = JSON.parse(await fsp.readFile(path.join(sdkPath, 'package.json'), 'utf8')) as {
    version?: unknown
  }
  const manifestPath = path.join(harnessDir, 'package.json')
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as Record<string, unknown>
  if (typeof sdk.version === 'string') manifest[BUNDLED_SDK_VERSION_FIELD] = sdk.version
  manifest[BUNDLED_TARGET_FIELD] = target
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * A `javascript` harness imports the dependencies bare-stow lists in its
 * `package.json` by name, from the project that holds the package.
 */
async function assertHarnessDependenciesResolve(entryPath: string, outputDir: string) {
  const manifest = JSON.parse(await fsp.readFile(path.join(outputDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (findInAncestorNodeModules(outputDir, name) !== null) continue
    throw new BundleFailedError(
      entryPath,
      new Error(`${HARNESS_FILE} imports '${name}', which the project cannot resolve`)
    )
  }
}

async function readFileIfExists(filePath: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Puts back `filePath`'s earlier content, or removes it when it had none. */
async function restoreFile(filePath: string, content: Buffer | null) {
  if (content === null) await fsp.rm(filePath, { force: true })
  else await fsp.writeFile(filePath, content)
}

async function assertOutputDirEmpty(outputDir: string, entryPath: string) {
  let entries: string[]
  try {
    entries = await fsp.readdir(outputDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new BundleFailedError(entryPath, error)
  }
  if (entries.length > 0) {
    throw new BundleFailedError(
      entryPath,
      new Error(`outputDir ${outputDir} must be empty or not exist yet`)
    )
  }
}

export async function bundleSdk(options: BundleSdkOptions = {}): Promise<BundleSdkResult> {
  const startTime = Date.now()

  const projectRoot = path.resolve(options.projectRoot ?? process.cwd())
  const qvacDir = path.join(projectRoot, 'qvac')
  const outputDir = path.resolve(options.outputDir ?? path.join(qvacDir, 'worker'))
  const entryPath = path.join(qvacDir, 'worker.entry.mjs')
  if (options.outputDir !== undefined) await assertOutputDirEmpty(outputDir, entryPath)
  const entryFromOutput = path.relative(outputDir, entryPath)
  if (!entryFromOutput.startsWith('..') && !path.isAbsolute(entryFromOutput)) {
    throw new BundleFailedError(
      entryPath,
      new Error(`outputDir ${outputDir} must not contain the worker entry`)
    )
  }
  const target = options.target ?? 'bare-sidecar'
  const language = options.language ?? (target === 'bare-kit' ? 'kotlin' : 'javascript')
  const languageOptions = options.languageOptions ?? {}

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
    for (const runtime of ['bare-stow-runtime', 'bare-stow-runtime/process']) {
      imports[runtime] = pathToFileURL(sdkRequire.resolve(runtime)).href
    }
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

  if (target === 'react-native') await assertReactNativeBareKitSupported(projectRoot, sdkPath)

  await fsp.mkdir(qvacDir, { recursive: true })
  const scanOutputDir = path.join(qvacDir, 'worker-scan')
  await removeStaleScratch(outputDir)
  await removeStaleScratch(scanOutputDir)

  const stowOptions = {
    projectRoot,
    entryPath,
    target,
    language,
    languageOptions,
    outputDir,
    hosts,
    imports,
    deferModules
  }

  const addonsMissingPlatformPackages = () =>
    reachedAddonsMissingPlatformPackages({
      addons: async () =>
        (await resolveAddons(projectRoot, undefined, logger)).filter(
          (addon) => !deferModules.includes(addon.name)
        ),
      hosts,
      scan: async (extraDefer) => {
        const scanDir = await scratchFolderFor(scanOutputDir)
        try {
          const bundlePath = await stowBundle({
            ...stowOptions,
            outputDir: scanDir,
            deferModules: [...deferModules, ...extraDefer]
          })
          return (await readBundle(bundlePath)).resolutions
        } finally {
          await discardScratch(scanDir)
        }
      },
      logger
    })

  // The bundle and the app's native modules are built in scratch folders and
  // replace the old ones together, so a failure leaves the working ones in place.
  // bare-stow names the bundle's main after the entry's folder, so the entry is
  // bundled from its own path and its previous content is restored on failure.
  const previousEntry = await readFileIfExists(entryPath)
  const scratch = await scratchFolderFor(outputDir)
  const staged: Staged[] = [{ dir: outputDir, next: scratch }]
  let installedPrebuilds: HostPrebuildPackage[] = []
  let addons: string[]
  let addonModules: string[]
  let linked: string[] = []
  let verification: VerifyBundleResult | null = null
  let bundlePath: string
  let replaced = false
  try {
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

    const missingPlatformAddons = await addonsMissingPlatformPackages()
    if (options.installMissingPrebuilds === true) {
      // Desktop packages are never installed, so a missing one is reported
      // before package.json changes.
      await throwIfPlatformPackagesMissing(
        missingPlatformAddons,
        hosts.filter((host) => !isMobileHost(host))
      )
      const { installed } = await installMissingHostPrebuilds({
        projectRoot,
        hosts,
        addons: missingPlatformAddons,
        quiet: options.quiet === true,
        logger
      })
      installedPrebuilds = installed
    } else {
      await throwIfPlatformPackagesMissing(missingPlatformAddons, hosts)
    }

    const scratchBundlePath = await stowBundle({ ...stowOptions, outputDir: scratch })
    if (language === 'javascript') await stampBundle(scratch, sdkPath, target)
    bundlePath = path.join(outputDir, path.relative(scratch, scratchBundlePath))

    const stats = await fsp.stat(scratchBundlePath)
    const sizeKB = (stats.size / 1024).toFixed(1)
    logger.info(`\n✅ Bundle created: ${path.relative(projectRoot, bundlePath)}`)
    logger.info(`   Size: ${sizeKB} KB`)

    const listOptions = { bundlePath: scratchBundlePath, projectRoot, logger, includeAudioDecoder }
    addons = await listBundledAddons(listOptions)
    addonModules = await listBundledAddonModules(listOptions)
    logger.info(`   Native addons (${addons.length}): ${addons.join(', ') || '(none)'}`)

    if (options.verify !== false) {
      verification = await verifyOutput({
        projectRoot,
        bundlePath: scratchBundlePath,
        hosts,
        target,
        network: options.network,
        logger
      })
    }

    if (target === 'react-native' && options.link !== false) {
      const linkHosts = Array.isArray(options.link) ? options.link : hosts
      logger.info('\n🔗 Writing Bare Kit and the native addons into the app...')
      const nativeModules = await stageAddons({
        projectRoot,
        entryPath,
        hosts: linkHosts,
        imports,
        defer: deferModules,
        logger
      })
      staged.push(...nativeModules.staged)
      linked = nativeModules.written
      logger.info(`   Wrote ${linked.length} files`)
    }

    await replaceAll(staged)
    replaced = true
    for (const stale of STALE_QVAC_FILES) await fsp.rm(path.join(qvacDir, stale), { force: true })
  } catch (error) {
    if (!replaced) await restoreFile(entryPath, previousEntry)
    throw error
  } finally {
    await discardStaged(staged)
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
  logger.info(`\n🎉 Done in ${elapsed}s!\n`)
  logger.info('Generated files:')
  logger.info(`  - ${path.relative(projectRoot, entryPath)}    (worker entry)`)
  logger.info(`  - ${path.relative(projectRoot, outputDir)}    (starts the bundled worker)`)
  logger.info(`  - ${path.relative(projectRoot, bundlePath)}\n`)

  return {
    target,
    language,
    hosts,
    entryPath,
    outputDir,
    bundlePath,
    plugins: pluginSpecifiers,
    addons,
    addonModules,
    installedPrebuilds,
    linked,
    verification
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
