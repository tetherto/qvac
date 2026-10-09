import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
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
  HostPrebuildsInstallRefusedError,
  UnexpectedDeferredImportsError
} from '@/utils/errors-client'
import { resolvePluginSpecifiers, parseBuiltinSpecifier } from '@/commands/bundle/plugins'
import { generateWorkerEntry } from '@/commands/bundle/entry-gen'
import { AUDIO_DECODER_ADDON, listBundledAddons } from '@/commands/bundle/addons'
import { linkAddons } from '@/commands/bundle/link'
import { readBundle } from '@/commands/bundle/read-bundle'
import { TARGETS, type BundleTarget } from '@/commands/bundle/targets'
import {
  installMissingHostPrebuilds,
  type HostPrebuildPackage
} from '@/commands/host-prebuilds/index'
import { collectAddonsFromBundle } from '@/commands/verify/bundle-source'
import { isMobileHost } from '@/commands/verify/prebuilds'
import { verifyBundle } from '@/commands/verify/index'
import { formatRuntimeSource } from '@/commands/verify/abi'
import { formatEnginesAdvice } from '@/commands/verify/engines-advice'
import type { Logger } from '@/logging/types'

const require = createRequire(import.meta.url)

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
   * Install the addon platform packages the bundle needs for its mobile hosts
   * with the project's package manager (see `ensureHostPrebuilds`), then
   * bundle again. Off by default: without it, bundling never changes
   * package.json or node_modules. When the install is refused, the bundle is
   * still written before `HostPrebuildsInstallRefusedError` is thrown.
   */
  installMissingPrebuilds?: boolean | undefined
  /**
   * For the `react-native` target, check the bundled packages' engines.bare
   * against the Bare runtime in react-native-bare-kit and warn on a mismatch.
   * Defaults to true; callers that run `verifyBundle` on the result can turn
   * it off.
   */
  checkEngines?: boolean | undefined
  /** Allow network lookups during the engines check. Defaults to true. */
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

  try {
    const pkgJsonPath = require.resolve('@qvac/sdk/package.json', {
      paths: [projectRoot]
    })
    return path.dirname(pkgJsonPath)
  } catch {
    return path.join(projectRoot, 'node_modules', '@qvac', 'sdk')
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

interface CheckBundleEnginesOptions {
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
  'audiogen-ggml'
])

function audioPluginsIn(pluginSpecifiers: string[], sdkName: string): string[] {
  return pluginSpecifiers.filter((specifier) => {
    const builtin = parseBuiltinSpecifier(specifier, sdkName)
    return builtin !== null && AUDIO_PLUGINS.has(builtin.suffix)
  })
}

async function checkBundleEngines(options: CheckBundleEnginesOptions) {
  const { projectRoot, bundlePath, hosts, network, logger } = options

  logger.info('\n🔎 Checking engines.bare against the Bare runtime in react-native-bare-kit...')
  const result = await verifyBundle({
    projectRoot,
    addonsSource: bundlePath,
    hosts,
    ...(network !== undefined ? { network } : {}),
    onProgress: (message) => logger.info(`   ${message}`)
  })

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

const DEFERRED_PREFIX = 'deferred:'
const HOST_ADDON_IMPORT = '#host-addon'

/**
 * Deferred imports the bundle may hold: the ones the caller asked for, and the
 * own-package `require.addon()` of a split addon, which falls back to its
 * `#host-addon` platform package at run time.
 */
function findUnexpectedDeferredImports(
  resolutions: Record<string, unknown>,
  deferModules: string[]
): string[] {
  const unexpected: string[] = []
  for (const [module, map] of Object.entries(resolutions)) {
    if (typeof map !== 'object' || map === null) continue
    const imports = map as Record<string, unknown>
    for (const [specifier, target] of Object.entries(imports)) {
      if (typeof target !== 'string' || !target.startsWith(DEFERRED_PREFIX)) continue
      if (deferModules.includes(specifier)) continue
      if (specifier === '.' && HOST_ADDON_IMPORT in imports) continue
      unexpected.push(`${specifier} (imported from ${module})`)
    }
  }
  return unexpected
}

interface StowWorkerOptions {
  entryPath: string
  target: BundleTarget
  outputDir: string
  projectRoot: string
  hosts: string[]
  imports: Record<string, unknown>
  deferModules: string[]
}

async function stowWorker(options: StowWorkerOptions): Promise<string> {
  const { entryPath, target, outputDir, projectRoot, hosts, imports, deferModules } = options
  const spec = TARGETS[target]
  const harnessPath = path.join(outputDir, spec.harness)

  await fsp.rm(outputDir, { recursive: true, force: true })

  // bare-module-traverse types its options from bare-addon-resolve, which lacks
  // the `imports` and `defer` that bare-module-resolve takes.
  const stowOptions: stow.StowOptions & { imports: Record<string, unknown>; defer: string[] } = {
    base: pathToFileURL(projectRoot + path.sep).href,
    imports,
    defer: deferModules,
    hosts,
    deferUnresolved: spec.offload
  }

  const written: string[] = []
  try {
    for await (const artifact of stow(
      pathToFileURL(entryPath).href,
      await spec.load(),
      pathToFileURL(harnessPath).href,
      stowOptions
    )) {
      written.push(artifact.url.pathname)
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

export async function bundleSdk(options: BundleSdkOptions = {}): Promise<BundleSdkResult> {
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

  const sdkPath = resolveSdkPath(projectRoot, options.sdkPath)
  const sdkName = await resolveSdkName(sdkPath)
  logger.info(`📦 SDK: ${sdkName}`)
  logger.debug(`   Path: ${sdkPath}`)

  const importsMapPath = resolveImportsMapPath(sdkPath, sdkName)
  const imports = JSON.parse(await fsp.readFile(importsMapPath, 'utf8')) as Record<string, unknown>

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
    generateWorkerEntry(pluginSpecifiers, sdkName, config.rpcServerProvider),
    'utf8'
  )
  logger.info(`   Created: ${path.relative(projectRoot, entryPath)}`)

  logger.info(`\n🔨 Bundling for ${target}...`)
  logger.debug(`   Hosts: ${hosts.join(', ')}`)
  if (deferModules.length > 0) {
    logger.debug(`   Deferred: ${deferModules.join(', ')}`)
  }

  const stowOptions = { entryPath, target, outputDir, projectRoot, hosts, imports, deferModules }
  let bundlePath = await stowWorker(stowOptions)

  let installedPrebuilds: HostPrebuildPackage[] = []
  let installRefused: HostPrebuildsInstallRefusedError | undefined
  if (options.installMissingPrebuilds === true) {
    try {
      const { installed } = await installMissingHostPrebuilds({
        projectRoot,
        hosts,
        addons: (await collectAddonsFromBundle({ bundlePath, projectRoot, hosts })).filter(
          (addon) => includeAudioDecoder || addon.name !== AUDIO_DECODER_ADDON
        ),
        quiet: options.quiet === true,
        logger
      })
      installedPrebuilds = installed
      // Where a platform package was missing, the bundle resolved the addon's
      // `#host-addon` import to its fallback module; bundle again to pick up
      // the installed package.
      if (installed.length > 0) {
        logger.info('\n🔨 Bundling again with the installed platform packages...')
        bundlePath = await stowWorker(stowOptions)
      }
    } catch (error: unknown) {
      if (!(error instanceof HostPrebuildsInstallRefusedError)) throw error
      installRefused = error
    }
  }

  const bundle = await readBundle(bundlePath)
  const unexpectedDeferred = findUnexpectedDeferredImports(
    bundle.resolutions as Record<string, unknown>,
    deferModules
  )
  if (unexpectedDeferred.length > 0) throw new UnexpectedDeferredImportsError(unexpectedDeferred)

  const stats = await fsp.stat(bundlePath)
  const sizeKB = (stats.size / 1024).toFixed(1)
  logger.info(`\n✅ Bundle created: ${path.relative(projectRoot, bundlePath)}`)
  logger.info(`   Size: ${sizeKB} KB`)

  const addons = await listBundledAddons({ bundlePath, projectRoot, logger, includeAudioDecoder })
  logger.info(`   Native addons (${addons.length}): ${addons.join(', ') || '(none)'}`)

  if (target === 'react-native' && options.checkEngines !== false) {
    await checkBundleEngines({
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
    linked = await linkAddons({ projectRoot, entryPath, hosts, logger })
    logger.info(`   Wrote ${linked.length} files`)
  }

  if (installRefused !== undefined) throw installRefused

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
    installedPrebuilds,
    linked
  }
}
