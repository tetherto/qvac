import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DEFAULT_HOSTS, DEFAULT_SDK_NAME } from '@/commands/bundle/constants'
import {
  CONFIG_CANDIDATES,
  resolveConfigForProject
} from '@/client/config-loader/resolve-config.node'
import { getClientLogger } from '@/logging'
import type { Logger } from '@/logging/types'
import { BareImportsMapNotFoundError } from '@/utils/errors-client'
import { resolvePluginSpecifiers, parseBuiltinSpecifier } from '@/commands/bundle/plugins'
import { generateWorkerEntries } from '@/commands/bundle/entry-gen'
import { runBarePack } from '@/commands/bundle/bare-pack'
import { generateAddonsManifest } from '@/commands/bundle/manifest'
import { createSdkImportResolver } from '@/commands/bundle/resolve-sdk-import'
import { verifyBundle } from '@/commands/verify/index'
import { formatRuntimeSource } from '@/commands/verify/abi'
import { formatEnginesAdvice } from '@/commands/verify/engines-advice'

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

function createCommandLogger(options: BundleSdkOptions): Logger {
  if (options.quiet) {
    return getClientLogger({ level: 'error', enableConsole: false })
  }
  // The client logger keeps console output off unless asked; the bundler's
  // progress and warnings are meant for the person running it.
  if (options.verbose) {
    return getClientLogger({ level: 'debug', enableConsole: true })
  }
  return getClientLogger({ enableConsole: true })
}

interface CheckBundleEnginesOptions {
  projectRoot: string
  bundlePath: string
  hosts: string[]
  configPath: string | undefined
  network: boolean | undefined
  logger: Logger
}

const ENGINES_ISSUE_CODES = new Set(['abi-mismatch', 'engines-mismatch', 'unknown-runtime-version'])

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

  for (const group of result.runtimes ?? []) {
    const label = group.hosts.join(', ')
    if (group.resolution.resolved) {
      logger.info(
        `   ${label}: Bare ${group.resolution.runtime.version} (from ${formatRuntimeSource(group.resolution.runtime)})`
      )
    } else {
      logger.debug(`   ${label}: ${group.resolution.error.reason}`)
    }
  }

  const enginesIssues = result.issues.filter((issue) => ENGINES_ISSUE_CODES.has(issue.code))
  const mismatches = enginesIssues.filter((issue) => issue.level === 'error')
  if (mismatches.length === 0) {
    for (const issue of enginesIssues) logger.debug(`   ${issue.message}`)
    logger.info('   No engines.bare mismatches')
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

  const deferModules = options.defer ?? []

  await fsp.mkdir(outputDir, { recursive: true })

  logger.info('\n📝 Generating worker entry...')
  const resolveSdkImport = createSdkImportResolver(sdkPath, sdkName)
  const { runtimeEntry, bundleEntry } = generateWorkerEntries(
    pluginSpecifiers,
    sdkName,
    resolveSdkImport
  )
  await fsp.writeFile(entryPath, runtimeEntry, 'utf8')
  logger.info(`   Created: ${path.relative(projectRoot, entryPath)}`)
  logger.info(`   Using: ${path.relative(projectRoot, importsMapPath)}`)

  logger.info('\n🔨 Bundling with bare-pack...')
  logger.debug(`   Hosts: ${hosts.join(', ')}`)
  if (deferModules.length > 0) {
    logger.debug(`   Deferred: ${deferModules.join(', ')}`)
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
    logger
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
    manifestPath: manifestResult.manifestPath
  }
}
