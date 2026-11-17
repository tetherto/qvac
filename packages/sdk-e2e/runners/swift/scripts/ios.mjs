#!/usr/bin/env node
// The Swift e2e app on iOS (`qvac-test run:local:swift-ios`).
//
//   ios.mjs prepare   build the app for the simulator and install it
//   ios.mjs run       start the app on this run and follow its log until it reports done
//   ios.mjs build     build the app only; --device builds for iPhones instead of the simulator
//   ios.mjs ipa [out] build for iPhones and package the app for Device Farm
//                     (default build/consumers/swift-ios/consumer.ipa)
//
// A device build signs with QVAC_IOS_TEAM_ID, QVAC_IOS_CODE_SIGN_IDENTITY and
// QVAC_IOS_PROVISIONING_PROFILE when set; QVAC_IOS_BUNDLE_ID sets its bundle id.
//
// `prepare` runs before the producer: its consumer-registration window is too short for a build.
// The app speaks MQTT itself, so `run` only points it at the broker, through the framework's env
// (QVAC_RUN_ID, QVAC_MQTT_BROKER_URL, ...). QVAC_IOS_SIMULATOR names the simulator (name or UDID);
// without it a booted iPhone is used, or the first available one is booted.
import { execFileSync, spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleSdk } from '@qvac/sdk/commands'

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const e2eRoot = path.resolve(runnerRoot, '..', '..')
const iosRoot = path.join(runnerRoot, 'ios')
const resourcesRoot = path.join(iosRoot, 'E2E')
const derivedData = path.join(iosRoot, 'build')
const doneLine = '👋 Consumer shutting down...'

const [command = 'prepare', ...flags] = process.argv.slice(2)
const device = flags.includes('--device') || command === 'ipa'

// CI builds under the React Native app's bundle id, which its provisioning profile names.
const bundleId = setting('QVAC_IOS_BUNDLE_ID', 'io.tether.qvac.e2e.swift')
const productName = 'QvacSwiftE2E'

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options
  })
}

function setting(name, fallback) {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

/** The MQTT 5 session expiry range, checked the way the JS mobile and Kotlin builds check it. */
function sessionExpiry(raw) {
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (!/^\d+$/.test(raw) || seconds < 1 || seconds > 4294967294) {
    throw new Error(`MQTT session expiry must be 1..4294967294 seconds, got "${raw}"`)
  }
  return seconds
}

function caFile(raw) {
  if (raw === undefined) return undefined
  const file = path.resolve(raw)
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`the MQTT CA file does not exist: ${file}`)
  }
  return readFileSync(file, 'utf8')
}

/** The run baked into the app; the launch environment overrides it on a simulator. */
function consumerConfig() {
  const expiry = setting(
    'QVAC_MQTT_SESSION_EXPIRY',
    process.env.GITHUB_ACTIONS === 'true' ? '7200' : undefined
  )
  return {
    runId: setting('E2E_RUN_ID', '*'),
    platform: setting('QVAC_TEST_PLATFORM', 'swift-ios'),
    mqtt: {
      protocol: setting('MQTT_PROTOCOL', 'ws'),
      host: setting('MQTT_HOST', 'localhost'),
      port: setting('MQTT_PORT', '8080'),
      path: setting('MQTT_PATH', '/mqtt'),
      username: setting('MQTT_USERNAME'),
      password: setting('MQTT_PASSWORD'),
      ca: caFile(setting('MQTT_CA_PATH')),
      rejectUnauthorized: true,
      sessionExpiryInterval: sessionExpiry(expiry)
    }
  }
}

/** The catalog, the resource table, the fixtures and the settings the app carries under E2E/. */
function stageResources() {
  rmSync(resourcesRoot, { recursive: true, force: true })
  mkdirSync(path.join(resourcesRoot, 'resources'), { recursive: true })
  execFileSync(
    'npm',
    ['run', '--silent', 'emit:catalog-json', '--', '--out', path.join(resourcesRoot, 'catalog')],
    {
      cwd: e2eRoot,
      stdio: 'inherit'
    }
  )
  for (const file of ['resource-table.json', 'platform-policy.json']) {
    cpSync(
      path.join(e2eRoot, 'catalog', 'resources', file),
      path.join(resourcesRoot, 'resources', file)
    )
  }
  cpSync(path.join(e2eRoot, 'assets'), path.join(resourcesRoot, 'fixtures'), { recursive: true })
  const { plugins, rpcServerProvider, ...worker } = JSON.parse(
    readFileSync(path.join(e2eRoot, 'fixtures', 'qvac.config.e2e.json'), 'utf8')
  )
  writeFileSync(
    path.join(resourcesRoot, 'worker-config.json'),
    `${JSON.stringify(worker, null, 2)}\n`
  )
  writeFileSync(
    path.join(resourcesRoot, 'consumer-config.json'),
    `${JSON.stringify(consumerConfig(), null, 2)}\n`
  )
}

async function build() {
  const hosts = device
    ? ['ios-arm64']
    : [`ios-${process.arch === 'arm64' ? 'arm64' : 'x64'}-simulator`]
  const outputDir = path.join(iosRoot, 'QvacWorker')
  rmSync(outputDir, { recursive: true, force: true })
  // The bundle's npm install keeps the SDK copy install:build made and leaves package.json as is.
  const npmSettings = { npm_config_install_links: 'true', npm_config_save: 'false' }
  const previous = Object.fromEntries(
    Object.keys(npmSettings).map((key) => [key, process.env[key]])
  )
  Object.assign(process.env, npmSettings)
  let bundle
  try {
    bundle = await bundleSdk({
      projectRoot: e2eRoot,
      configPath: path.join(e2eRoot, 'fixtures', 'qvac.config.e2e.json'),
      target: 'bare-kit',
      language: 'swift',
      outputDir,
      hosts,
      installMissingPrebuilds: true,
      quiet: true
    })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  console.log(
    `Bundled the e2e worker for ${hosts.join(', ')} with ${bundle.addons.length} native addons`
  )
  stageResources()
  execFileSync(
    'xcodebuild',
    [
      '-project',
      path.join(iosRoot, 'QvacSwiftE2E.xcodeproj'),
      '-scheme',
      'QvacSwiftE2E',
      '-configuration',
      'Release',
      '-destination',
      device ? 'generic/platform=iOS' : 'generic/platform=iOS Simulator',
      '-derivedDataPath',
      derivedData,
      '-quiet',
      'build',
      // The worker is bundled for this Mac's simulator architecture only.
      ...(device ? signing() : [`ARCHS=${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`]),
      // The app target's own setting: a plain PRODUCT_BUNDLE_IDENTIFIER would apply to every
      // package target too.
      `QVAC_APP_BUNDLE_ID=${bundleId}`
    ],
    { stdio: 'inherit' }
  )
  return path.join(
    derivedData,
    'Build',
    'Products',
    device ? 'Release-iphoneos' : 'Release-iphonesimulator',
    `${productName}.app`
  )
}

/**
 * Manual signing for a device build when CI provides it (the Device Farm job's keychain and
 * provisioning profile); otherwise Xcode's automatic signing.
 */
function signing() {
  const profile = setting('QVAC_IOS_PROVISIONING_PROFILE')
  if (!profile) return []
  return [
    'QVAC_APP_CODE_SIGN_STYLE=Manual',
    `QVAC_APP_TEAM_ID=${setting('QVAC_IOS_TEAM_ID', '')}`,
    `QVAC_APP_CODE_SIGN_IDENTITY=${setting('QVAC_IOS_CODE_SIGN_IDENTITY', 'Apple Distribution')}`,
    `QVAC_APP_PROVISIONING_PROFILE=${profile}`
  ]
}

/** A device build as Device Farm takes it: the app under Payload/, zipped. */
async function ipa(output) {
  const app = await build()
  const staging = path.join(derivedData, 'ipa')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(path.join(staging, 'Payload'), { recursive: true })
  run('ditto', [app, path.join(staging, 'Payload', path.basename(app))])
  mkdirSync(path.dirname(output), { recursive: true })
  rmSync(output, { force: true })
  run('ditto', [
    '-c',
    '-k',
    '--sequesterRsrc',
    '--keepParent',
    path.join(staging, 'Payload'),
    output
  ])
  return output
}

/** The simulator to use, booted. */
function simulator() {
  const { devices } = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '-j']))
  const all = Object.values(devices).flat()
  const wanted = process.env.QVAC_IOS_SIMULATOR
  const chosen = wanted
    ? all.find((entry) => entry.udid === wanted || entry.name === wanted)
    : (all.find((entry) => entry.state === 'Booted' && entry.name.startsWith('iPhone')) ??
      all.find((entry) => entry.name.startsWith('iPhone')))
  if (!chosen)
    throw new Error(wanted ? `no simulator named ${wanted}` : 'no iPhone simulator is available')
  if (chosen.state !== 'Booted') {
    console.log(`Booting ${chosen.name}...`)
    run('xcrun', ['simctl', 'bootstatus', chosen.udid, '-b'])
  }
  return chosen.udid
}

async function prepare() {
  const app = await build()
  const udid = simulator()
  run('xcrun', ['simctl', 'install', udid, app])
  console.log(`Installed the Swift e2e app on simulator ${udid}`)
}

/** Launches the app on this run and follows its output until the consumer shuts down. */
function follow() {
  const udid = simulator()
  const env = { ...process.env }
  for (const name of [
    'QVAC_RUN_ID',
    'QVAC_TEST_PLATFORM',
    'QVAC_MQTT_BROKER_URL',
    'QVAC_MQTT_USERNAME',
    'QVAC_MQTT_PASSWORD',
    'QVAC_MQTT_SESSION_EXPIRY'
  ]) {
    if (process.env[name]) env[`SIMCTL_CHILD_${name}`] = process.env[name]
  }
  const child = spawn(
    'xcrun',
    ['simctl', 'launch', '--console-pty', '--terminate-running-process', udid, bundleId],
    {
      env,
      stdio: ['ignore', 'pipe', 'inherit']
    }
  )
  let pending = ''
  let done = false
  child.stdout.on('data', (chunk) => {
    pending += chunk.toString()
    const lines = pending.split('\n')
    pending = lines.pop()
    for (const line of lines) {
      const text = line.replace(/^QvacE2E: /, '')
      console.log(text)
      if (text.includes(doneLine) && !done) {
        done = true
        setTimeout(() => {
          spawn('xcrun', ['simctl', 'terminate', udid, bundleId], { stdio: 'ignore' })
          child.kill()
        }, 2000)
      }
    }
  })
  child.on('exit', () => {
    if (!done) console.error('the app exited before the consumer shut down')
    process.exit(done ? 0 : 1)
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      spawn('xcrun', ['simctl', 'terminate', udid, bundleId], { stdio: 'ignore' })
      child.kill()
      process.exit(1)
    })
  }
}

switch (command) {
  case 'build':
    console.log(await build())
    break
  case 'prepare':
    await prepare()
    break
  case 'run':
    follow()
    break
  case 'ipa':
    console.log(
      await ipa(
        path.resolve(
          flags.find((flag) => !flag.startsWith('--')) ?? 'build/consumers/swift-ios/consumer.ipa'
        )
      )
    )
    break
  default:
    console.error(`unknown command "${command}"; use prepare, run, build or ipa`)
    process.exit(1)
}
