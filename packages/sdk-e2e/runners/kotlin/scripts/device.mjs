#!/usr/bin/env node
// The Kotlin consumer on an Android device, for `qvac-test run:local:external --name=kotlin-android`.
//
//   node runners/kotlin/scripts/device.mjs prepare   assemble the APK and install it (the entry's prepare step)
//   node runners/kotlin/scripts/device.mjs run       start it on this run and follow its log
//   node runners/kotlin/scripts/device.mjs build     assemble the APK only (CI, which runs it on Device Farm)
//
// `prepare` runs before the producer, which gives consumers a fixed window to register: a build
// and a 400 MB install do not fit in it. `run` is the external consumer itself: the app speaks MQTT
// on its own, so this only points it at the broker on this machine and exits when the app reports
// it is done.
// The run comes from the framework's environment (QVAC_RUN_ID, QVAC_MQTT_BROKER_URL, ...); the
// device from ANDROID_SERIAL when there is more than one.

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(here, '..')
const e2eRoot = path.resolve(projectDir, '../..')
const gradlew = path.resolve(
  e2eRoot,
  '../sdk-kotlin',
  process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'
)
const builtApk = path.join(projectDir, 'app/build/outputs/apk/release/app-release.apk')
const apk = path.join(e2eRoot, 'build/consumers/kotlin-android/consumer.apk')
const appPackage = 'io.tether.qvac.e2e.kotlin'
const activity = `${appPackage}/io.tether.qvac.e2e.MainActivity`
const logTag = 'QvacE2E'

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
    '/opt/homebrew/share/android-commandlinetools'
  ]
  // Any SDK root will do: the Android Gradle plugin installs the platform it compiles against.
  return candidates.find((candidate) => candidate && existsSync(candidate))
}

function build() {
  const sdk = androidSdk()
  if (!sdk) fail('no Android SDK found: set ANDROID_HOME')
  // No daemon on CI: a persistent runner would keep it after the job.
  const daemon = process.env.CI ? ['--no-daemon'] : []
  // Only the all-in-one runtime profile: building the Kotlin SDK's other profiles is wasted here.
  const args = [':app:assembleRelease', '-PqvacProfile=aio', '--console=plain', ...daemon]
  const result = spawnSync(gradlew, args, {
    cwd: projectDir,
    stdio: 'inherit',
    env: { ...process.env, ANDROID_HOME: sdk }
  })
  if (result.status !== 0) fail(`gradle exited with code ${result.status}`)
  mkdirSync(path.dirname(apk), { recursive: true })
  copyFileSync(builtApk, apk)
  console.log(`📦 ${path.relative(process.cwd(), apk)}`)
}

function adbPath() {
  const sdk = androidSdk()
  const bundled =
    sdk && path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
  return bundled && existsSync(bundled) ? bundled : 'adb'
}

/** Intent extras whose values must not reach a log. */
const SECRET_EXTRAS = new Set(['mqttUsername', 'mqttPassword'])

function adb(args, { check = true } = {}) {
  const result = spawnSync(adbPath(), args, { encoding: 'utf8' })
  if (check && result.status !== 0) {
    const shown = args.map((arg, index) => (SECRET_EXTRAS.has(args[index - 1]) ? '***' : arg))
    fail(`adb ${shown.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`)
  }
  return result.stdout ?? ''
}

function pickDevice() {
  const serials = adb(['devices'])
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial)
  if (serials.length === 0) fail('no Android device connected (adb devices)')
  const wanted = process.env.ANDROID_SERIAL
  if (wanted && !serials.includes(wanted)) fail(`ANDROID_SERIAL=${wanted} is not connected`)
  return wanted ?? serials[0]
}

/** Addresses that mean "this machine", which the device reaches through `adb reverse` instead. */
function localHosts() {
  const hosts = new Set(['localhost', '127.0.0.1', '::1'])
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) hosts.add(address.address)
  }
  return hosts
}

/**
 * The broker as the device should dial it. A broker on this machine is reached through
 * `adb reverse`, so the run does not depend on the device and the laptop sharing a network.
 */
/** Ports this run reversed onto the device, removed again when it ends. */
const reversed = []

function deviceBrokerUrl(serial) {
  const raw = process.env.QVAC_MQTT_BROKER_URL
  if (!raw) fail('QVAC_MQTT_BROKER_URL is not set; run this through qvac-test run:local:external')
  const url = new URL(raw)
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    fail(`the app connects over WebSocket; the broker URL is ${raw} (set MQTT_PROTOCOL=ws)`)
  }
  const pathSuffix = process.env.MQTT_PATH ?? ''
  if (pathSuffix && url.pathname === '/') url.pathname = pathSuffix
  // A certificate names its host, so a TLS broker is dialled as configured; only plain WebSocket
  // is pointed at the reversed port.
  // URL keeps IPv6 hosts bracketed; the interface list does not.
  if (url.protocol === 'ws:' && localHosts().has(url.hostname.replace(/^\[|\]$/g, ''))) {
    const port = url.port || (url.protocol === 'wss:' ? '443' : '80')
    adb(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`])
    reversed.push(`tcp:${port}`)
    url.hostname = '127.0.0.1'
    console.log(`🔁 adb reverse tcp:${port} -> this machine`)
  }
  return url.toString()
}

function install() {
  const serial = pickDevice()
  console.log(`📲 Installing on ${serial}...`)
  adb(['-s', serial, 'install', '-r', '-d', apk])
}

function run() {
  const serial = pickDevice()
  console.log(`📱 Device: ${serial}`)
  const installed = adb(['-s', serial, 'shell', 'pm', 'path', appPackage], { check: false })
  if (!installed.includes('package:'))
    fail(`${appPackage} is not installed on ${serial}; drop --skip-build`)
  const brokerUrl = deviceBrokerUrl(serial)
  // Awake and unlocked: a consumer behind the lock screen is a stopped activity, which some OEM
  // builds freeze outright.
  adb(['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { check: false })
  adb(['-s', serial, 'shell', 'wm', 'dismiss-keyguard'], { check: false })
  adb(['-s', serial, 'shell', 'am', 'force-stop', appPackage])
  adb(['-s', serial, 'logcat', '-c'], { check: false })

  const extras = [
    ['runId', process.env.QVAC_RUN_ID],
    ['platform', process.env.QVAC_TEST_PLATFORM],
    ['brokerUrl', brokerUrl],
    ['mqttUsername', process.env.QVAC_MQTT_USERNAME],
    ['mqttPassword', process.env.QVAC_MQTT_PASSWORD],
    ['mqttSessionExpiry', process.env.QVAC_MQTT_SESSION_EXPIRY]
  ].filter(([, value]) => value)
  const start = ['-s', serial, 'shell', 'am', 'start', '-W', '-n', activity]
  for (const [key, value] of extras) start.push('--es', key, `'${value.replaceAll("'", "'\\''")}'`)
  adb(start)
  console.log(`🚀 Started ${appPackage} on run ${process.env.QVAC_RUN_ID}\n`)

  // The app's own log is the consumer's output; it ends with the line the JS consumers end with.
  // The worker runs in-process (a Bare worklet), so this one pid is the whole consumer, and the log
  // is read for it alone: another app crashing on a developer's phone is not this run's failure.
  const pidOf = () => adb(['-s', serial, 'shell', 'pidof', appPackage], { check: false }).trim()
  const pid = pidOf()
  if (!pid) fail(`${appPackage} did not start`)
  const logcat = spawn(
    adbPath(),
    ['-s', serial, 'logcat', `--pid=${pid}`, '-v', 'raw', '-s', `${logTag}:*`, 'AndroidRuntime:E'],
    {
      stdio: ['ignore', 'pipe', 'inherit']
    }
  )
  let pending = ''
  let finished = false
  logcat.stdout.setEncoding('utf8')
  logcat.stdout.on('data', (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('--------- beginning of')) continue
      console.log(line)
      if (line.includes('Consumer shutting down')) finished = true
      if (line.includes('FATAL EXCEPTION')) {
        console.error('❌ The app crashed')
        stop(1)
      }
    }
    if (finished) setTimeout(() => stop(0), 2000)
  })
  logcat.on('exit', (code) => {
    if (!finished) fail(`logcat exited (${code}) before the consumer finished`)
  })

  // A native crash in the worker takes the process down without a Java stack trace, and the
  // producer would otherwise wait out its timeouts for a consumer that is gone.
  const watch = setInterval(() => {
    if (finished || pidOf() === pid) return
    const crash = adb(['-s', serial, 'logcat', '-d', '-v', 'brief'], { check: false })
      .split('\n')
      .filter(
        (line) => line.includes(`(${pid})`) && /Fatal signal|Uncaught|F DEBUG|abort/i.test(line)
      )
    console.error(`❌ The app died (pid ${pid})`)
    for (const line of crash.slice(-10)) console.error(`   ${line}`)
    stop(1)
  }, 5000)

  let stopping = false
  function stop(code) {
    if (stopping) return
    stopping = true
    clearInterval(watch)
    logcat.kill()
    for (const port of reversed) adb(['-s', serial, 'reverse', '--remove', port], { check: false })
    if (code !== 0) adb(['-s', serial, 'shell', 'am', 'force-stop', appPackage], { check: false })
    process.exit(code)
  }
  process.on('SIGINT', () => stop(130))
  process.on('SIGTERM', () => stop(143))
}

const command = process.argv[2]
if (command === 'prepare') {
  build()
  install()
} else if (command === 'run') {
  run()
} else if (command === 'build') {
  build()
} else {
  fail(`usage: device.mjs prepare|run|build (got ${command ?? 'nothing'})`)
}
