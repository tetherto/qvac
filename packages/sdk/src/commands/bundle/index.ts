import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DEFAULT_HOSTS, DEFAULT_SDK_NAME } from '@/commands/bundle/constants'
import {
  CONFIG_CANDIDATES,
  resolveConfigForProject
} from '@/client/config-loader/resolve-config.node'
import { createCommandLogger } from '@/commands/command-logger'
import { BareImportsMapNotFoundError, HostPrebuildsMissingError } from '@/utils/errors-client'
import { resolvePluginSpecifiers, parseBuiltinSpecifier } from '@/commands/bundle/plugins'
import { generateWorkerEntries } from '@/commands/bundle/entry-gen'
import { runBarePack } from '@/commands/bundle/bare-pack'
import { AUDIO_DECODER_ADDON, generateAddonsManifest } from '@/commands/bundle/manifest'
import { createSdkImportResolver } from '@/commands/bundle/resolve-sdk-import'
import {
  findMissingHostPrebuilds,
  installMissingHostPrebuilds,
  resolveAddons,
  type HostPrebuildPackage
} from '@/commands/host-prebuilds/index'
import type { NativeAddon } from '@/commands/verify/addon-source'
import { verifyBundle } from '@/commands/verify/index'
import { formatRuntimeSource } from '@/commands/verify/abi'
import { formatEnginesAdvice } from '@/commands/verify/engines-advice'
import type { Logger } from '@/logging/types'

const require = createRequire(import.meta.url)

export interface BundleSdkOptions {
  projectRoot?: string | undefined
  configPath?: string | undefined
  sdkPath?: string | undefined
  hosts?: string[] | undefined
  defer?: string[] | undefined
  quiet?: boolean | undefined
  verbose?: boolean | undefined
  /**
   * Install the addon platform packages the project's split addons need for
   * its mobile hosts with the project's package manager (see
   * `ensureHostPrebuilds`) before bundling. Off by default: without it,
   * bundling never changes package.json or node_modules, and a mobile host
   * whose platform package is missing fails with `HostPrebuildsMissingError`,
   * naming the exact pins. A refused install
   * throws `HostPrebuildsInstallRefusedError` before anything is written.
   */
  installMissingPrebuilds?: boolean | undefined
  /**
   * Check the bundled packages' engines.bare against the Bare runtime of each
   * host and warn on a mismatch. Defaults to true; callers that run
   * `verifyBundle` on the result can turn it off.
   */
  checkEngines?: boolean | undefined
  /** Allow network lookups during the engines check. Defaults to true. */
  network?: boolean | undefined
}

export interface BundleSdkResult {
  bundlePath: string
  plugins: string[]
  addons: string[]
  entryPaths: { worker: string }
  manifestPath: string
  /** Platform packages `installMissingPrebuilds` installed; empty when it is off. */
  installedPrebuilds: HostPrebuildPackage[]
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
  configPath: string | undefined
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
  const { projectRoot, bundlePath, hosts, configPath, network, logger } = options

  logger.info('\n🔎 Checking engines.bare against the Bare runtime of each host...')
  const result = await verifyBundle({
    projectRoot,
    addonsSource: bundlePath,
    hosts,
    ...(configPath !== undefined ? { configPath } : {}),
    ...(network !== undefined ? { network } : {}),
    onProgress: (message) => logger.info(`   ${message}`)
  })

  const checkedHosts: string[] = []
  for (const group of result.runtimes ?? []) {
    const label = group.hosts.join(', ')
    if (group.resolution.resolved) {
      checkedHosts.push(...group.hosts)
      logger.info(
        `   ${label}: Bare ${group.resolution.runtime.version} (from ${formatRuntimeSource(group.resolution.runtime)})`
      )
    } else {
      logger.warn(`engines.bare not checked for ${label}: ${group.resolution.error.reason}`)
    }
  }

  const mismatches = result.issues.filter(
    (issue) => ENGINES_ISSUE_CODES.has(issue.code) && issue.level === 'error'
  )
  if (mismatches.length === 0) {
    if (checkedHosts.length > 0) {
      logger.info(`   No engines.bare mismatches for ${checkedHosts.join(', ')}`)
    }
    return
  }

  const lines = ['The bundle contains packages that require a newer Bare runtime:']
  for (const issue of mismatches) lines.push(`  - ${issue.message}`)
  lines.push('')
  for (const advice of result.advice ?? []) lines.push(...formatEnginesAdvice(advice))
  logger.warn(lines.join('\n').trimEnd())
}

export async function bundleSdk(options: BundleSdkOptions = {}): Promise<BundleSdkResult> {
  const startTime = Date.now()

  const projectRoot = options.projectRoot ?? process.cwd()
  const outputDir = path.join(projectRoot, 'qvac')
  const entryPath = path.join(outputDir, 'worker.entry.mjs')
  const bundleEntryPath = path.join(outputDir, 'worker.bundle.entry.mjs')
  const bundlePath = path.join(outputDir, 'worker.bundle.js')

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

  const pluginSpecifiers = resolvePluginSpecifiers(config, sdkName, logger)
  logger.info(`\n📦 Plugins to include (${pluginSpecifiers.length}):`)
  for (const spec of pluginSpecifiers) {
    const label = parseBuiltinSpecifier(spec, sdkName) ? '✓ built-in' : '⊕ custom'
    logger.info(`   ${label}: ${spec}`)
  }

  const hosts = options.hosts && options.hosts.length > 0 ? options.hosts : DEFAULT_HOSTS

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

  await fsp.mkdir(outputDir, { recursive: true })

  logger.info('\n📝 Generating worker entry...')
  const resolveSdkImport = createSdkImportResolver(sdkPath, sdkName)
  const { runtimeEntry, bundleEntry } = generateWorkerEntries(
    pluginSpecifiers,
    sdkName,
    resolveSdkImport,
    config.rpcServerProvider
  )
  await fsp.writeFile(entryPath, runtimeEntry, 'utf8')
  logger.info(`   Created: ${path.relative(projectRoot, entryPath)}`)
  logger.info(`   Using: ${path.relative(projectRoot, importsMapPath)}`)

  logger.info('\n🔨 Bundling with bare-pack...')
  logger.debug(`   Hosts: ${hosts.join(', ')}`)
  if (deferModules.length > 0) {
    logger.debug(`   Deferred: ${deferModules.join(', ')}`)
  }

  // A split addon's `binding.js` is `require('#host-addon')`, which bare-pack
  // cannot resolve for a host whose platform package is missing, so the
  // packages go in before the first bundle.
  let installedPrebuilds: HostPrebuildPackage[] = []
  const projectAddons = async () =>
    (await resolveAddons(projectRoot, undefined, logger)).filter(
      (addon) => includeAudioDecoder || addon.name !== AUDIO_DECODER_ADDON
    )
  if (options.installMissingPrebuilds === true) {
    const { installed } = await installMissingHostPrebuilds({
      projectRoot,
      hosts,
      addons: await projectAddons(),
      quiet: options.quiet === true,
      logger
    })
    installedPrebuilds = installed
  }

  try {
    await fsp.writeFile(bundleEntryPath, bundleEntry, 'utf8')
    await runBarePack({
      entryPath: bundleEntryPath,
      outputPath: bundlePath,
      hosts,
      importsMapPath,
      deferModules,
      quiet: options.quiet === true,
      logger
    })
  } catch (error: unknown) {
    if (options.installMissingPrebuilds !== true) {
      await throwIfPlatformPackagesMissing(await projectAddons(), hosts, error)
    }
    throw error
  } finally {
    await fsp.rm(bundleEntryPath, { force: true })
  }

  const stats = await fsp.stat(bundlePath)
  const sizeKB = (stats.size / 1024).toFixed(1)
  logger.info(`\n✅ Bundle created: ${path.relative(projectRoot, bundlePath)}`)
  logger.info(`   Size: ${sizeKB} KB`)

  const manifestResult = await generateAddonsManifest({
    bundlePath,
    outputDir,
    projectRoot,
    logger,
    includeAudioDecoder
  })

  if (options.checkEngines !== false) {
    await checkBundleEngines({
      projectRoot,
      bundlePath,
      hosts,
      configPath: configPath ?? undefined,
      network: options.network,
      logger
    })
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
  logger.info(`\n🎉 Done in ${elapsed}s!\n`)
  logger.info('Generated files:')
  logger.info('  - qvac/worker.entry.mjs    (standalone worker with RPC + lifecycle)')
  logger.info('  - qvac/worker.bundle.js    (mobile bundle for Expo/React Native BareKit)')
  logger.info('  - qvac/addons.manifest.json\n')
  logger.info('Mobile: Expo plugin auto-configures worker.bundle.js')
  logger.info('Standalone: Import qvac/worker.entry.mjs for full worker with RPC\n')

  return {
    bundlePath,
    plugins: pluginSpecifiers,
    addons: manifestResult.addons,
    entryPaths: {
      worker: entryPath
    },
    manifestPath: manifestResult.manifestPath,
    installedPrebuilds
  }
}

/**
 * Turns a failed bare-pack into `HostPrebuildsMissingError` when split addons
 * are missing mobile platform packages: their `#host-addon` import cannot
 * resolve without them.
 */
async function throwIfPlatformPackagesMissing(
  addons: NativeAddon[],
  hosts: string[],
  cause: unknown
) {
  let missing: HostPrebuildPackage[]
  try {
    missing = await findMissingHostPrebuilds(addons, hosts)
  } catch {
    return
  }
  if (missing.length === 0) return
  throw new HostPrebuildsMissingError(
    Object.fromEntries(missing.map((pkg) => [pkg.name, pkg.version])),
    cause
  )
}
