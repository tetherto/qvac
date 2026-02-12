import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import { DEFAULT_HOSTS, DEFAULT_SDK_NAME } from './constants.js'
import { createLogger } from '../logger.js'
import { findConfigFile, loadConfig, CONFIG_CANDIDATES } from '../config.js'
import { BareImportsMapNotFoundError } from '../errors.js'
import { resolvePluginSpecifiers, parseBuiltinSpecifier } from './plugins.js'
import {
  generateWorkerEntry,
  generatePearWorkerEntry,
  toRelativeImportSpecifier
} from './entry-gen.js'
import { runBarePack } from './bare-pack.js'
import { generateAddonsManifest } from './manifest.js'

async function resolveSdkName (projectRoot) {
  const sdkPackageJsonPath = path.join(
    projectRoot,
    'node_modules',
    '@qvac',
    'sdk',
    'package.json'
  )

  try {
    if (fs.existsSync(sdkPackageJsonPath)) {
      const content = await fsp.readFile(sdkPackageJsonPath, 'utf8')
      const pkg = JSON.parse(content)
      return pkg.name
    }
  } catch {
    // Fall through to default
  }

  return DEFAULT_SDK_NAME
}

function resolveImportsMapPath (projectRoot, sdkName) {
  const fromNodeModules = path.join(
    projectRoot,
    'node_modules',
    sdkName,
    'bare-imports.json'
  )

  if (fs.existsSync(fromNodeModules)) {
    return fromNodeModules
  }

  throw new BareImportsMapNotFoundError(sdkName, fromNodeModules)
}

export async function bundleSdk (options = {}) {
  const startTime = Date.now()

  const projectRoot = options.projectRoot ?? process.cwd()
  const outputDir = path.join(projectRoot, 'qvac')
  const entryPath = path.join(outputDir, 'worker.entry.mjs')
  const pearWorkerEntryPath = path.join(outputDir, 'worker.pear.entry.mjs')
  const bundlePath = path.join(outputDir, 'worker.bundle.js')

  let logLevel = 'info'
  if (options.quiet) logLevel = 'silent'
  else if (options.verbose) logLevel = 'debug'

  const logger = createLogger(logLevel)

  logger.info('🔧 QVAC SDK Worker Bundler\n')

  const configPath = findConfigFile(projectRoot, options.configPath)

  let config = {}
  if (configPath) {
    logger.info(`📄 Config: ${path.relative(projectRoot, configPath)}`)
    config = await loadConfig(configPath)
  } else {
    logger.info('📄 Config: (none)')
    logger.warn('No config file found — continuing with defaults.')
    logger.info(
      '   To customize bundling, create one of:\n' +
      CONFIG_CANDIDATES.map((c) => `     - ${c}`).join('\n') +
      '\n'
    )
  }

  const sdkName = await resolveSdkName(projectRoot)
  logger.info(`📦 SDK: ${sdkName}`)

  const importsMapPath = resolveImportsMapPath(projectRoot, sdkName)

  const pluginSpecifiers = resolvePluginSpecifiers(config, sdkName, logger)
  logger.info(`\n📦 Plugins to include (${pluginSpecifiers.length}):`)
  for (const spec of pluginSpecifiers) {
    const label = parseBuiltinSpecifier(spec, sdkName)
      ? '✓ built-in'
      : '⊕ custom'
    logger.info(`   ${label}: ${spec}`)
  }

  const hosts =
    options.hosts && options.hosts.length > 0 ? options.hosts : DEFAULT_HOSTS

  const deferModules = options.defer ?? []

  await fsp.mkdir(outputDir, { recursive: true })

  logger.info('\n📝 Generating worker entry...')
  const workerEntry = generateWorkerEntry(pluginSpecifiers, sdkName)
  await fsp.writeFile(entryPath, workerEntry, 'utf8')
  logger.info(`   Created: ${path.relative(projectRoot, entryPath)}`)

  const pearWorker =
    typeof config.pearWorker === 'string' && config.pearWorker.length > 0
      ? config.pearWorker
      : 'worker.js'

  const pearWorkerAbs = path.isAbsolute(pearWorker)
    ? pearWorker
    : path.join(projectRoot, pearWorker)
  const pearWorkerImport = toRelativeImportSpecifier(outputDir, pearWorkerAbs)

  const pearWorkerEntry = generatePearWorkerEntry(
    pluginSpecifiers,
    sdkName,
    pearWorkerImport
  )
  await fsp.writeFile(pearWorkerEntryPath, pearWorkerEntry, 'utf8')
  logger.info(`   Created: ${path.relative(projectRoot, pearWorkerEntryPath)}`)
  logger.info(`   Using: ${path.relative(projectRoot, importsMapPath)}`)

  logger.info('\n🔨 Bundling with bare-pack...')
  logger.debug(`   Hosts: ${hosts.join(', ')}`)
  if (deferModules.length > 0) {
    logger.debug(`   Deferred: ${deferModules.join(', ')}`)
  }

  await runBarePack({
    projectRoot,
    entryPath,
    outputPath: bundlePath,
    hosts,
    importsMapPath,
    deferModules,
    logLevel,
    logger
  })

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

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
  logger.info(`\n🎉 Done in ${elapsed}s!\n`)
  logger.info('Generated files:')
  logger.info(
    '  - qvac/worker.entry.mjs    (standalone worker with RPC + lifecycle)'
  )
  logger.info(
    '  - qvac/worker.pear.entry.mjs (Pear worker entrypoint: plugins + app worker)'
  )
  logger.info(
    '  - qvac/worker.bundle.js    (mobile bundle for Expo/React Native BareKit)'
  )
  logger.info('  - qvac/addons.manifest.json\n')
  logger.info(
    'Pear apps: Spawn qvac/worker.pear.entry.mjs as your worker entrypoint'
  )
  logger.info('Mobile: Expo plugin auto-configures worker.bundle.js')
  logger.info(
    'Standalone: Import qvac/worker.entry.mjs for full worker with RPC\n'
  )

  return {
    bundlePath,
    plugins: pluginSpecifiers,
    addons: manifestResult.addons,
    entryPaths: {
      worker: entryPath,
      pearWorker: pearWorkerEntryPath
    },
    manifestPath: manifestResult.manifestPath
  }
}
