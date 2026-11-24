#!/usr/bin/env node
// The Kotlin e2e consumer on a desktop JVM (`qvac-test run:local:kotlin-desktop`).
//
//   desktop.mjs prepare   build the program (:desktop:installDist)
//   desktop.mjs run       start it on this run; it exits when the consumer is done
//   desktop.mjs build     build only (CI; --prebuilt-sdk when packages/sdk is already built)
//
// `prepare` runs before the producer: its consumer-registration window is too short for a build.
// The run comes from the framework's env (QVAC_RUN_ID, QVAC_MQTT_BROKER_URL, ...).

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(here, '..')
const e2eRoot = path.resolve(projectDir, '../..')
const sdkKotlin = path.resolve(e2eRoot, '../sdk-kotlin')
const windows = process.platform === 'win32'
const gradlew = path.join(sdkKotlin, windows ? 'gradlew.bat' : 'gradlew')
const installDir = path.join(projectDir, 'desktop/build/install/qvac-e2e-desktop')
const mainClass = 'io.tether.qvac.e2e.desktop.MainKt'

function fail(message) {
  console.error(`❌ ${message}`)
  process.exit(1)
}

function androidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.HOME && path.join(process.env.HOME, 'Library/Android/sdk'),
    process.env.HOME && path.join(process.env.HOME, 'Android/Sdk'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android/Sdk')
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate))
}

function build() {
  // The build configures the Android app and packages/sdk-kotlin's Android modules beside the
  // desktop program, so Gradle needs an Android SDK even though nothing Android is built.
  const sdk = androidSdk()
  if (!sdk) fail('no Android SDK found: set ANDROID_HOME')
  // No daemon on CI: a persistent runner would keep it after the job.
  const daemon = process.env.CI ? ['--no-daemon'] : []
  // --prebuilt-sdk: CI builds packages/sdk before this; skip Gradle's rebuild and its Python.
  const prebuilt = process.argv.includes('--prebuilt-sdk')
    ? ['-x', ':sdk-kotlin:android-barekit:buildWorkspaceSdk']
    : []
  const args = [':desktop:installDist', ...prebuilt, '--console=plain', ...daemon]
  // A .bat runs only through a shell; every argument here is free of spaces and quotes.
  const result = spawnSync(gradlew, args, {
    cwd: projectDir,
    stdio: 'inherit',
    shell: windows,
    env: { ...process.env, ANDROID_HOME: sdk }
  })
  if (result.status !== 0) fail(`gradle exited with code ${result.status}`)
}

/**
 * The broker URL as the program dials it: Paho names TCP and TLS `tcp://` and `ssl://`, and the
 * framework's URL carries no WebSocket path. Errors never print the URL: it may carry credentials.
 */
function brokerUrl() {
  const raw = process.env.QVAC_MQTT_BROKER_URL
  if (!raw)
    fail('QVAC_MQTT_BROKER_URL is not set; run this through qvac-test run:local:kotlin-desktop')
  let url
  try {
    url = new URL(raw)
  } catch {
    fail('QVAC_MQTT_BROKER_URL is not a valid URL')
  }
  const pathSuffix = process.env.MQTT_PATH ?? ''
  if (pathSuffix && (url.protocol === 'ws:' || url.protocol === 'wss:') && url.pathname === '/') {
    url.pathname = pathSuffix
  }
  const scheme = { 'mqtt:': 'tcp:', 'mqtts:': 'ssl:' }[url.protocol]
  return scheme ? `${scheme}${url.href.slice(url.protocol.length)}` : url.href
}

function java() {
  const home = process.env.JAVA_HOME
  const bundled = home && path.join(home, 'bin', windows ? 'java.exe' : 'java')
  return bundled && existsSync(bundled) ? bundled : 'java'
}

function run() {
  if (!existsSync(path.join(installDir, 'lib')))
    fail(`${installDir} is not built; drop --skip-build`)
  const utf8 = ['stdout', 'stderr'].flatMap((stream) => [
    `-D${stream}.encoding=UTF-8`,
    `-Dsun.${stream}.encoding=UTF-8`
  ])
  const child = spawn(java(), [...utf8, '-cp', path.join(installDir, 'lib', '*'), mainClass], {
    cwd: projectDir,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: {
      ...process.env,
      QVAC_MQTT_BROKER_URL: brokerUrl(),
      QVAC_E2E_FIXTURES: path.join(e2eRoot, 'assets')
    }
  })
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  child.on('error', (error) => fail(`could not start java: ${error.message}`))
  // The framework stops the consumer with a signal; the program's shutdown hook leaves the broker.
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}

const command = process.argv[2]
if (command === 'prepare' || command === 'build') {
  build()
} else if (command === 'run') {
  run()
} else {
  fail(`usage: desktop.mjs prepare|run|build (got ${command ?? 'nothing'})`)
}
