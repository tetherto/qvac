import * as os from 'node:os'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { loadConfig } from '../../utils/config-loader.js'
import { snapConsumerSchema } from '../../types/config.js'
import { buildMqttConnectionConfig } from '../../utils/mqtt-connection.js'
import {
  spawnTracked,
  killTracked,
  printPidTable,
  printLogPaths,
  detectLanIp,
  createReportDir,
  generateRunId,
  startDeviceLogCapture,
  type TrackedProcess
} from '../utils/process-manager.js'
import { ensureBroker, type BrokerHandle } from '../utils/local-broker.js'
import { writeLocalMobileEnv } from '../utils/env-writer.js'
import {
  detectAndroidDevices,
  installAndroidApk,
  launchAndroidApp,
  getAndroidAppPid,
  detectAppleTeamId
} from '../utils/device-utils.js'
import { buildConsumerMobile } from './build-consumer-mobile.js'
import { buildConsumerElectron } from './build-consumer-electron.js'
import { buildConsumerSnap } from './build-consumer-snap.js'
import { resolveSnapArtifactPath } from '../utils/snap-build-utils.js'
import {
  assertSnapHostPlatform,
  installSnapArtifact,
  isSnapInstalled,
  resolveSnapMountedPath,
  runSnapAdmin
} from '../utils/snap-utils.js'

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface LocalOptions {
  config: string
  runId?: string
  filter?: string
  suite?: string
  excludeSuite?: string
  alsoTests?: string
  reportDir?: string
}

interface AndroidOptions extends LocalOptions {
  skipBuild?: boolean
  device?: string
}

interface IosOptions extends LocalOptions {
  skipBuild?: boolean
  bundleSuffix?: string
  device?: string
}

interface ElectronOptions extends LocalOptions {
  skipBuild?: boolean
  skipInstall?: boolean
  platform?: string
  arch?: string
}

interface SnapOptions extends LocalOptions {
  skipBuild?: boolean
  skipInstall?: boolean
  skipSnapInstall?: boolean
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveCliPath(): string {
  const __filename = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(__filename), '../index.js')
}

function buildProducerArgs(
  cliPath: string,
  runId: string,
  configDir: string,
  reportDir: string,
  opts: LocalOptions
): string[] {
  const args = [
    cliPath,
    'run:producer',
    `--runId=${runId}`,
    `--config=${configDir}`,
    `--report-dir=${reportDir}`
  ]
  if (opts.filter) args.push(`--filter=${opts.filter}`)
  if (opts.suite) args.push(`--suite=${opts.suite}`)
  if (opts.excludeSuite) args.push(`--exclude-suite=${opts.excludeSuite}`)
  if (opts.alsoTests) args.push(`--also-tests=${opts.alsoTests}`)
  return args
}

function buildConsumerArgs(cliPath: string, runId: string, configDir: string): string[] {
  return [cliPath, 'run:consumer:desktop', `--runId=${runId}`, `--config=${configDir}`]
}

function buildElectronConsumerArgs(
  cliPath: string,
  runId: string,
  configDir: string,
  brokerUrl: string,
  opts: ElectronOptions
): string[] {
  const args = [
    cliPath,
    'run:consumer:electron',
    `--runId=${runId}`,
    `--config=${configDir}`,
    `--mqtt-broker=${brokerUrl}`,
    '--skip-build'
  ]
  if (opts.platform) args.push(`--platform=${opts.platform}`)
  if (opts.arch) args.push(`--arch=${opts.arch}`)
  return args
}

function buildSnapConsumerArgs(
  cliPath: string,
  runId: string,
  configDir: string,
  brokerUrl: string
): string[] {
  return [
    cliPath,
    'run:consumer:snap',
    `--runId=${runId}`,
    `--config=${configDir}`,
    `--mqtt-broker=${brokerUrl}`,
    '--skip-build',
    '--skip-snap-install'
  ]
}

function removeSnap(snapName: string): void {
  try {
    runSnapAdmin(['remove', '--purge', snapName])
  } catch {
    console.warn(`⚠️  Failed to remove Snap ${snapName}; manual cleanup may be required`)
  }
}

function assertSnapNotInstalled(snapName: string): void {
  if (isSnapInstalled(snapName)) {
    throw new Error(
      `Snap ${snapName} is already installed; use --skip-snap-install to reuse it without replacement, or remove it manually`
    )
  }
}

async function setupLocal(opts: LocalOptions): Promise<{
  runId: string
  configDir: string
  reportDir: string
  brokerUrl: string
  brokerHandle: BrokerHandle
}> {
  const configDir = path.resolve(opts.config)
  const runId = opts.runId || generateRunId()

  // Detect LAN IP and ensure .env has correct local WS broker settings
  // before loading dotenv. This is needed for all platforms since the
  // producer and config both read from .env.
  const lanIp = detectLanIp()
  if (lanIp) {
    writeLocalMobileEnv(configDir, lanIp)
  }

  loadDotenv({ path: path.join(configDir, '.env') })

  console.log(`📂 Config: ${configDir}`)
  console.log(`🔑 Run ID: ${runId}\n`)

  const config = await loadConfig(configDir)
  const mqttConfig = buildMqttConnectionConfig(config)
  const brokerUrl = mqttConfig.brokerUrl

  const reportDir = createReportDir(configDir, runId, opts.reportDir)
  console.log(`📁 Report directory: ${reportDir}\n`)

  const brokerHandle = await ensureBroker(brokerUrl, reportDir)
  console.log('')

  return { runId, configDir, reportDir, brokerUrl, brokerHandle }
}

function setupCleanup(
  tracked: TrackedProcess[],
  reportDir: string,
  brokerHandle: BrokerHandle,
  extraCleanup?: () => void
): void {
  let cleaningUp = false
  const cleanup = (exitCode: number) => {
    if (cleaningUp) return
    cleaningUp = true
    console.log('\n⚠️  Shutting down...')
    killTracked(reportDir)
    extraCleanup?.()
    brokerHandle.cleanup()
    printLogPaths(reportDir)
    process.exit(exitCode)
  }

  process.on('SIGINT', () => cleanup(0))
  process.on('SIGTERM', () => cleanup(0))

  const producer = tracked.find((t) => t.name === 'producer')
  if (producer) {
    producer.child.on('exit', (code) => {
      console.log(`\n📊 Producer exited with code ${code ?? 0}`)
      cleanup(code ?? 0)
    })
  }

  for (const consumer of tracked.filter((trackedProcess) =>
    trackedProcess.name.startsWith('consumer-')
  )) {
    consumer.child.on('exit', (code, signal) => {
      if (cleaningUp || (signal === null && (code ?? 0) === 0)) return
      console.error(
        `\n❌ ${consumer.name} exited before the producer completed (code=${code ?? 'null'}, signal=${signal ?? 'none'})`
      )
      cleanup(code ?? 1)
    })
  }
}

// ---------------------------------------------------------------------------
// run:local:desktop
// ---------------------------------------------------------------------------

export async function runLocalDesktop(opts: LocalOptions) {
  try {
    console.log('🖥️  run:local:desktop\n')

    const { runId, configDir, reportDir, brokerHandle } = await setupLocal(opts)
    const cliPath = resolveCliPath()
    const tracked: TrackedProcess[] = []

    const producer = spawnTracked(
      'node',
      buildProducerArgs(cliPath, runId, configDir, reportDir, opts),
      {
        reportDir,
        name: 'producer',
        cwd: configDir
      }
    )
    tracked.push(producer)

    const consumer = spawnTracked('node', buildConsumerArgs(cliPath, runId, configDir), {
      reportDir,
      name: 'consumer-desktop',
      cwd: configDir
    })
    tracked.push(consumer)

    const pidEntries = tracked.map((t) => ({ name: t.name, pid: t.pid, logPath: t.logPath }))
    printPidTable(pidEntries)
    printLogPaths(reportDir)
    setupCleanup(tracked, reportDir, brokerHandle)
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`❌ run:local:desktop failed: ${msg}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// run:local:electron
// ---------------------------------------------------------------------------

export async function runLocalElectron(opts: ElectronOptions) {
  try {
    console.log('⚡ run:local:electron\n')

    const { runId, configDir, reportDir, brokerUrl, brokerHandle } = await setupLocal(opts)
    const cliPath = resolveCliPath()
    const tracked: TrackedProcess[] = []

    if (!opts.skipBuild) {
      await buildConsumerElectron({
        config: configDir,
        platform: opts.platform,
        arch: opts.arch,
        skipInstall: opts.skipInstall
      })
    } else {
      console.log('⏭️  Skipping Electron package build (--skip-build)\n')
    }

    const producer = spawnTracked(
      'node',
      buildProducerArgs(cliPath, runId, configDir, reportDir, opts),
      {
        reportDir,
        name: 'producer',
        cwd: configDir
      }
    )
    tracked.push(producer)

    const consumer = spawnTracked(
      'node',
      buildElectronConsumerArgs(cliPath, runId, configDir, brokerUrl, opts),
      {
        reportDir,
        name: 'consumer-electron',
        cwd: configDir
      }
    )
    tracked.push(consumer)

    const pidEntries = tracked.map((t) => ({ name: t.name, pid: t.pid, logPath: t.logPath }))
    printPidTable(pidEntries)
    printLogPaths(reportDir)
    setupCleanup(tracked, reportDir, brokerHandle)
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`❌ run:local:electron failed: ${msg}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// run:local:snap
// ---------------------------------------------------------------------------

export async function runLocalSnap(opts: SnapOptions) {
  let installedSnapName: string | undefined
  let activeBroker: BrokerHandle | undefined

  try {
    assertSnapHostPlatform(process.platform)
    console.log('📦 run:local:snap\n')

    const { runId, configDir, reportDir, brokerUrl, brokerHandle } = await setupLocal(opts)
    activeBroker = brokerHandle
    const config = await loadConfig(configDir)
    if (!config.consumers.snap) {
      throw new Error('No Snap consumer configuration found')
    }
    const snap = snapConsumerSchema.parse(config.consumers.snap)

    resolveSnapMountedPath(snap.snapName, snap.snapConfigDir ?? '.')
    resolveSnapMountedPath(snap.snapName, snap.entry)

    const appDir = path.resolve(configDir, snap.appDir)
    if (!opts.skipSnapInstall) {
      assertSnapNotInstalled(snap.snapName)
    }

    let artifactPath: string | undefined
    if (!opts.skipBuild) {
      artifactPath = await buildConsumerSnap({
        config: configDir,
        skipInstall: opts.skipInstall
      })
    } else {
      console.log('⏭️  Skipping Snap package build (--skip-build)\n')
      if (!opts.skipSnapInstall) {
        artifactPath = resolveSnapArtifactPath(appDir, snap.artifactPath)
      }
    }

    if (!opts.skipSnapInstall) {
      if (!artifactPath) {
        throw new Error('Snap artifact is required when installation is enabled')
      }

      assertSnapNotInstalled(snap.snapName)
      console.log(`📥 Installing Snap consumer: ${artifactPath}\n`)
      installSnapArtifact(artifactPath)
      installedSnapName = snap.snapName
    }

    const cliPath = resolveCliPath()
    const tracked: TrackedProcess[] = []

    const producer = spawnTracked(
      'node',
      buildProducerArgs(cliPath, runId, configDir, reportDir, opts),
      {
        reportDir,
        name: 'producer',
        cwd: configDir
      }
    )
    tracked.push(producer)

    const consumer = spawnTracked(
      'node',
      buildSnapConsumerArgs(cliPath, runId, configDir, brokerUrl),
      {
        reportDir,
        name: 'consumer-snap',
        cwd: configDir
      }
    )
    tracked.push(consumer)

    const pidEntries = tracked.map((trackedProcess) => ({
      name: trackedProcess.name,
      pid: trackedProcess.pid,
      logPath: trackedProcess.logPath
    }))
    printPidTable(pidEntries)
    printLogPaths(reportDir)
    setupCleanup(tracked, reportDir, brokerHandle, () => {
      if (installedSnapName) {
        removeSnap(installedSnapName)
        installedSnapName = undefined
      }
    })
  } catch (error: unknown) {
    if (installedSnapName) {
      removeSnap(installedSnapName)
    }
    activeBroker?.cleanup()
    const message = error instanceof Error ? error.message : String(error)
    console.error(`❌ run:local:snap failed: ${message}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// run:local:android
// ---------------------------------------------------------------------------

export async function runLocalAndroid(opts: AndroidOptions) {
  try {
    console.log('🤖 run:local:android\n')

    // When skipping build, use the runId baked into the existing build
    if (opts.skipBuild && !opts.runId) {
      const configDir = path.resolve(opts.config)
      const bakedId = readBakedRunId(configDir, 'android')
      if (bakedId) {
        opts.runId = bakedId
        console.log(`   Using baked runId from previous build: ${bakedId}`)
      }
    }

    const { runId, configDir, reportDir, brokerHandle } = await setupLocal(opts)

    // Detect Android device
    const devices = detectAndroidDevices()
    if (devices.length === 0) {
      console.error(
        '❌ No Android device detected.\n' +
          '   Connect a device via USB or start an emulator, then try again.\n' +
          '   Check with: adb devices'
      )
      process.exit(1)
    }

    const serial = opts.device || devices[0].serial
    console.log(`📱 Target device: ${serial}`)
    if (devices.length > 1 && !opts.device) {
      console.log(`   (${devices.length} devices found, using first. Use --device to select.)`)
    }
    console.log('')

    // Build APK
    if (!opts.skipBuild) {
      await buildConsumerMobile({ platform: 'android', config: configDir, runId })
    } else {
      console.log('⏭️  Skipping build (--skip-build)\n')
    }

    // Install + launch
    const apkPath = path.join(configDir, 'build/consumers/android/consumer.apk')
    installAndroidApk(serial, apkPath)

    const androidPackage = process.env.QVAC_ANDROID_PACKAGE || 'io.tether.qvac_test_consumer_mobile'
    launchAndroidApp(serial, androidPackage)
    console.log('')

    // Capture device logs silently to file
    const deviceLog = startDeviceLogCapture(reportDir, 'android', {
      serial,
      packageName: androidPackage
    })

    // Start producer
    const cliPath = resolveCliPath()
    const tracked: TrackedProcess[] = []

    const producer = spawnTracked(
      'node',
      buildProducerArgs(cliPath, runId, configDir, reportDir, opts),
      {
        reportDir,
        name: 'producer',
        cwd: configDir
      }
    )
    tracked.push(producer)

    const appPid = getAndroidAppPid(serial, androidPackage)

    const pidEntries = tracked.map((t) => ({ name: t.name, pid: t.pid, logPath: t.logPath }))
    if (appPid) {
      pidEntries.push({ name: 'consumer-android', pid: appPid, logPath: '(on device)' })
    }
    if (deviceLog) {
      pidEntries.push({
        name: 'device-log',
        pid: deviceLog.child.pid ?? 0,
        logPath: deviceLog.logPath
      })
    }
    printPidTable(pidEntries)
    printLogPaths(reportDir)

    setupCleanup(tracked, reportDir, brokerHandle, () => {
      deviceLog?.child.kill()
    })
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`❌ run:local:android failed: ${msg}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// run:local:ios
// ---------------------------------------------------------------------------

export async function runLocalIos(opts: IosOptions) {
  try {
    console.log('🍎 run:local:ios\n')

    // When skipping build, use the runId baked into the existing build
    if (opts.skipBuild && !opts.runId) {
      const configDir = path.resolve(opts.config)
      const bakedId = readBakedRunId(configDir, 'ios')
      if (bakedId) {
        opts.runId = bakedId
        console.log(`   Using baked runId from previous build: ${bakedId}`)
      }
    }

    const { runId, configDir, reportDir, brokerHandle } = await setupLocal(opts)

    // Auto-detect team ID if not set
    if (!process.env.QVAC_IOS_TEAM_ID) {
      const teamId = detectAppleTeamId()
      if (teamId) {
        process.env.QVAC_IOS_TEAM_ID = teamId
        console.log(`🔑 Auto-detected Apple Team ID: ${teamId}`)
      }
    }

    // Dynamic bundle ID
    const suffix = opts.bundleSuffix || os.userInfo().username
    const baseBundleId = process.env.QVAC_IOS_BUNDLE_ID || 'io.tether.qvac-test-consumer-mobile'
    const bundleId = `${baseBundleId}-${suffix}`
    process.env.QVAC_IOS_BUNDLE_ID = bundleId
    console.log(`📋 Bundle ID: ${bundleId} (suffix: ${suffix})`)
    console.log('')

    // Prepare iOS project (templates, config, prebuild) then build+install via expo
    const iosOutputDir = path.join(configDir, 'build/consumers/ios')
    // Detect iOS device early so we fail fast before a long build
    let deviceUdid = opts.device
    if (!deviceUdid) {
      const { detectIosDevices } = await import('../utils/device-utils.js')
      const devices = detectIosDevices()
      if (devices.length === 0) {
        console.error(
          '❌ No iOS device detected.\n' +
            '   Connect an iPhone via USB and trust it in Xcode, then try again.\n' +
            '   Check with: xcrun devicectl list devices'
        )
        process.exit(1)
      }
      deviceUdid = devices[0].udid
      console.log(`📱 Target device: ${devices[0].name} (${deviceUdid})`)
      if (devices.length > 1) {
        console.log(`   (${devices.length} devices found, using first. Use --device to select.)`)
      }
      console.log('')
    }

    const scheme = 'QVACTestConsumer'

    if (!opts.skipBuild) {
      await buildConsumerMobile({ platform: 'ios', config: configDir, runId, prepareOnly: true })

      const prebuildLog = path.join(reportDir, 'ios-prebuild.log')
      const buildLog = path.join(reportDir, 'ios-build.log')

      console.log('\n🔧 Running expo prebuild...')
      const prebuildOutput = execSync(`npx expo prebuild --clean --platform ios 2>&1`, {
        cwd: iosOutputDir,
        encoding: 'utf-8'
      })
      fs.writeFileSync(prebuildLog, prebuildOutput)
      console.log(`   Done (log: ${prebuildLog})`)

      const iosDir = path.join(iosOutputDir, 'ios')
      const workspace = 'QVACTestConsumer.xcworkspace'
      const teamId = process.env.QVAC_IOS_TEAM_ID || ''

      cleanDerivedData(scheme)

      console.log(`\n🏗️  Building for device ${deviceUdid} (team: ${teamId})...`)
      console.log(`   This may take a few minutes. Build log: ${buildLog}`)

      const buildLogFd = fs.openSync(buildLog, 'w')
      try {
        execSync(
          `xcodebuild -workspace ${workspace} -configuration Release -scheme ${scheme} ` +
            `-destination "id=${deviceUdid}" ` +
            `DEVELOPMENT_TEAM=${teamId} CODE_SIGN_STYLE=Automatic ` +
            `-allowProvisioningUpdates -quiet 2>&1`,
          { cwd: iosDir, stdio: ['ignore', buildLogFd, buildLogFd] }
        )
      } catch {
        const logContent = fs.readFileSync(buildLog, 'utf-8')
        const errors = logContent.split('\n').filter((l) => l.includes('error:'))
        console.error(`\n❌ xcodebuild failed. Errors:\n${errors.join('\n') || '(see full log)'}`)
        console.error(`   Full log: ${buildLog}`)
        process.exit(1)
      } finally {
        fs.closeSync(buildLogFd)
      }
      console.log('   ✅ Build succeeded')
    } else {
      console.log('⏭️  Skipping build (--skip-build)')
    }

    // Install and launch (runs regardless of --skip-build)
    const { installIosApp, launchIosApp } = await import('../utils/device-utils.js')
    const appPath = findBuiltApp(scheme)
    installIosApp(deviceUdid, appPath)
    launchIosApp(deviceUdid, bundleId, appPath)
    console.log('')

    // Capture device logs silently to file
    const deviceLog = startDeviceLogCapture(reportDir, 'ios', { udid: deviceUdid })

    // Start producer
    const cliPath = resolveCliPath()
    const tracked: TrackedProcess[] = []

    const producer = spawnTracked(
      'node',
      buildProducerArgs(cliPath, runId, configDir, reportDir, opts),
      {
        reportDir,
        name: 'producer',
        cwd: configDir
      }
    )
    tracked.push(producer)

    const pidEntries = tracked.map((t) => ({ name: t.name, pid: t.pid, logPath: t.logPath }))
    if (deviceLog) {
      pidEntries.push({
        name: 'device-log',
        pid: deviceLog.child.pid ?? 0,
        logPath: deviceLog.logPath
      })
    }
    printPidTable(pidEntries)
    printLogPaths(reportDir)

    setupCleanup(tracked, reportDir, brokerHandle, () => {
      deviceLog?.child.kill()
    })
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`❌ run:local:ios failed: ${msg}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import * as fs from 'node:fs'

/**
 * Read the baked runId from a previously built mobile consumer.
 * Returns undefined if not found.
 */
function readBakedRunId(configDir: string, platform: 'ios' | 'android'): string | undefined {
  const configPath = path.join(configDir, 'build', 'consumers', platform, 'consumer-config.ts')
  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    const match = content.match(/runId:\s*"([^"]+)"/)
    return match?.[1]
  } catch {
    return undefined
  }
}

function cleanDerivedData(scheme: string): void {
  const derivedData = path.join(os.homedir(), 'Library/Developer/Xcode/DerivedData')
  if (!fs.existsSync(derivedData)) return

  const stale = fs.readdirSync(derivedData).filter((d) => d.match(new RegExp(`^${scheme}-`)))
  for (const dir of stale) {
    try {
      const full = path.join(derivedData, dir)
      fs.rmSync(full, { recursive: true, force: true })
    } catch {
      // Locked by Xcode or another process -- ignore, xcodebuild will overwrite
    }
  }
  if (stale.length > 0) {
    console.log(`   Cleaned ${stale.length} stale DerivedData entries`)
  }
}

function findBuiltApp(scheme: string): string {
  const derivedData = path.join(os.homedir(), 'Library/Developer/Xcode/DerivedData')
  if (fs.existsSync(derivedData)) {
    // Match exactly "scheme-" to avoid matching "schemeExtra-"
    const dirs = fs
      .readdirSync(derivedData)
      .filter((d) => d.match(new RegExp(`^${scheme}-`)))
      .sort()
      .reverse()

    for (const dir of dirs) {
      const productsDir = path.join(derivedData, dir, 'Build', 'Products')
      if (!fs.existsSync(productsDir)) continue
      for (const config of fs.readdirSync(productsDir).filter((d) => d.endsWith('-iphoneos'))) {
        const apps = fs
          .readdirSync(path.join(productsDir, config))
          .filter((f) => f.endsWith('.app'))
        if (apps.length > 0) return path.join(productsDir, config, apps[0])
      }
    }
  }

  throw new Error(
    `Could not find built .app for scheme "${scheme}". Check that the build succeeded.`
  )
}
