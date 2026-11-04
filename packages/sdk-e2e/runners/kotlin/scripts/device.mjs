#!/usr/bin/env node
// The Kotlin e2e app on an Android device (`qvac-test run:local:kotlin-android`).
//
//   device.mjs prepare   build the APK and install it
//   device.mjs run       start the app on this run and follow its log until it reports done
//   device.mjs build     build the APK only (CI; --prebuilt-sdk when packages/sdk is already built)
//
// `prepare` runs before the producer: its consumer-registration window is too short for a build and
// a large APK install. The app speaks MQTT itself, so `run` only points it at the broker.
// The run comes from the framework's env (QVAC_RUN_ID, QVAC_MQTT_BROKER_URL, ...); the device from
// ANDROID_SERIAL when several are connected.

import { execFile, spawn, spawnSync } from 'node:child_process'
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

/** Cleanup run on any exit, last first: adb reverse, the log follower, stopping a failed app. */
const undo = []
let exiting = false

function exit(code) {
  if (exiting) return
  exiting = true
  for (const step of undo.splice(0).reverse()) step(code)
  process.exit(code)
}

function fail(message) {
  console.error(`❌ ${message}`)
  exit(1)
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
  // aio only: the Kotlin SDK's other runtime profiles are not needed here.
  // --prebuilt-sdk: CI builds packages/sdk before packing it; skip Gradle's rebuild and its Python.
  const prebuilt = process.argv.includes('--prebuilt-sdk')
    ? ['-x', ':sdk-kotlin:android-barekit:buildWorkspaceSdk']
    : []
  const args = [
    ':app:assembleRelease',
    '-PqvacProfile=aio',
    '--console=plain',
    ...daemon,
    ...prebuilt
  ]
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

/** Errors name `what`, never the args: `am start` carries the broker credentials. */
function adb(args, { check = true, what = 'adb' } = {}) {
  // A logcat dump can exceed the 1 MiB default, which would cut off the tail where the crash is.
  const result = spawnSync(adbPath(), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (check && result.status !== 0) {
    fail(`${what} failed: ${(result.stderr || result.stdout || '').trim()}`)
  }
  return result.stdout ?? ''
}

function pickDevice() {
  const serials = adb(['devices'], { what: 'adb devices' })
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
 * The broker URL as the device dials it. A local broker goes through `adb reverse`, so the device
 * need not share this machine's network. Errors never print the URL: it may carry credentials.
 */
function deviceBrokerUrl(serial) {
  const raw = process.env.QVAC_MQTT_BROKER_URL
  if (!raw) fail('QVAC_MQTT_BROKER_URL is not set; run this through qvac-test run:local:external')
  let url
  try {
    url = new URL(raw)
  } catch {
    fail('QVAC_MQTT_BROKER_URL is not a valid URL')
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    fail(`the app connects over WebSocket, not ${url.protocol} (set MQTT_PROTOCOL=ws)`)
  }
  const pathSuffix = process.env.MQTT_PATH ?? ''
  if (pathSuffix && url.pathname === '/') url.pathname = pathSuffix
  // Only ws:// is reversed: a TLS certificate names its host, so wss:// is dialled as configured.
  // URL keeps IPv6 hosts bracketed; networkInterfaces() does not.
  if (url.protocol === 'ws:' && localHosts().has(url.hostname.replace(/^\[|\]$/g, ''))) {
    const port = url.port || '80'
    adb(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`], {
      what: `adb reverse tcp:${port}`
    })
    undo.push(() => adb(['-s', serial, 'reverse', '--remove', `tcp:${port}`], { check: false }))
    url.hostname = '127.0.0.1'
    console.log(`🔁 adb reverse tcp:${port} -> this machine`)
  }
  return url.toString()
}

function install() {
  const serial = pickDevice()
  console.log(`📲 Installing on ${serial}...`)
  adb(['-s', serial, 'install', '-r', '-d', apk], { what: 'adb install' })
}

function run() {
  process.on('SIGINT', () => exit(130))
  process.on('SIGTERM', () => exit(143))
  const serial = pickDevice()
  console.log(`📱 Device: ${serial}`)
  const installed = adb(['-s', serial, 'shell', 'pm', 'path', appPackage], { check: false })
  if (!installed.includes('package:'))
    fail(`${appPackage} is not installed on ${serial}; drop --skip-build`)
  const brokerUrl = deviceBrokerUrl(serial)
  // Wake and unlock: behind the lock screen the activity is stopped, and some OEM builds freeze it.
  adb(['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { check: false })
  adb(['-s', serial, 'shell', 'wm', 'dismiss-keyguard'], { check: false })
  adb(['-s', serial, 'shell', 'am', 'force-stop', appPackage], { what: 'am force-stop' })
  adb(['-s', serial, 'logcat', '-c'], { check: false })
  undo.push((code) => {
    if (code !== 0) adb(['-s', serial, 'shell', 'am', 'force-stop', appPackage], { check: false })
  })

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
  adb(start, { what: `am start ${activity}` })
  console.log(`🚀 Started ${appPackage} on run ${process.env.QVAC_RUN_ID}\n`)

  // The app's log is the consumer output. The worker is an in-process Bare worklet, so this pid is
  // the whole consumer; filtering by it keeps other apps' crashes out of the run.
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
  undo.push(() => logcat.kill())
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
        exit(1)
      }
    }
    if (finished) setTimeout(() => exit(0), 2000)
  })
  logcat.on('exit', (code) => {
    if (!finished) fail(`logcat exited (${code}) before the consumer finished`)
  })

  // A native worker crash kills the process with no Java stack trace; without this the producer
  // waits out its timeouts.
  const watch = setInterval(() => {
    if (finished || pidOf() === pid) return
    const lines = adb(['-s', serial, 'logcat', '-d', `--pid=${pid}`, '-v', 'brief'], {
      check: false
    }).split('\n')
    // The log follower can lag the exit: an app that logged its shutdown finished, it did not die.
    if (lines.some((line) => line.includes('Consumer shutting down'))) {
      finished = true
      setTimeout(() => exit(0), 2000)
      return
    }
    const crash = lines.filter((line) => /Fatal signal|Uncaught|F DEBUG|abort/i.test(line))
    // A system kill (low memory, OEM policy) leaves nothing in the app's log; the system's has it.
    const killed = adb(['-s', serial, 'logcat', '-d', '-b', 'main,system,events', '-v', 'brief'], {
      check: false
    })
      .split('\n')
      .filter(
        (line) =>
          (line.includes(`pid ${pid}`) && line.includes('has died')) ||
          line.includes(`Process ${pid} exited due to signal`) ||
          (line.includes(appPackage) && /memUsage|lowmemorykiller|am_kill/i.test(line))
      )
    console.error(`❌ The app died (pid ${pid})`)
    for (const line of [...crash.slice(-10), ...killed.slice(-5)]) console.error(`   ${line}`)
    exit(1)
  }, 5000)
  undo.push(() => clearInterval(watch))

  sampleMemory(serial, pid).catch((error) => {
    console.error(`⚠️  Memory samples are not published: ${error.message}`)
  })
}

/**
 * Publishes the app's memory on `qvac/app-memory`, as the JS mobile consumer does, for the
 * producer's per-test chart. Sampled through adb. QVAC_ANDROID_MEM_DISABLED=1 turns it off;
 * QVAC_ANDROID_MEM_INTERVAL_MS sets the period.
 */
async function sampleMemory(serial, pid) {
  if (process.env.QVAC_ANDROID_MEM_DISABLED === '1') return
  // Lazy: `build` (CI) needs no MQTT client.
  const { default: mqtt } = await import('mqtt')
  const intervalMs = Number(process.env.QVAC_ANDROID_MEM_INTERVAL_MS) || 5000
  // This machine's broker URL, not the device's reversed one.
  const client = mqtt.connect(process.env.QVAC_MQTT_BROKER_URL, {
    username: process.env.QVAC_MQTT_USERNAME,
    password: process.env.QVAC_MQTT_PASSWORD,
    clientId: `kotlin-android-mem-${process.env.QVAC_RUN_ID}`,
    reconnectPeriod: 3000
  })
  let warned = false
  client.on('error', (error) => {
    if (warned) return
    warned = true
    console.error(`⚠️  Memory samples are not published: ${error.message}`)
  })

  let busy = false
  const sample = () => {
    if (busy) return
    busy = true
    execFile(
      adbPath(),
      ['-s', serial, 'shell', `cat /proc/${pid}/status; dumpsys meminfo ${pid}`],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        busy = false
        if (error || !client.connected) return
        const ts = Date.now()
        for (const { metric, kb, peakKb } of memoryReadings(stdout)) {
          const record = {
            runId: process.env.QVAC_RUN_ID,
            ts,
            pid: Number(pid),
            memoryKb: kb,
            peakKb,
            metric,
            unit: 'kb',
            platform: process.env.QVAC_TEST_PLATFORM ?? 'kotlin-android'
          }
          client.publish('qvac/app-memory', JSON.stringify(record), { qos: 0 })
        }
      }
    )
  }
  sample()
  const timer = setInterval(sample, intervalMs)
  undo.push(() => {
    clearInterval(timer)
    client.end(true)
  })
  console.log(`📈 Sampling the app's memory every ${intervalMs}ms (qvac/app-memory)`)
}

/**
 * RSS from /proc/<pid>/status, plus PSS from `dumpsys meminfo` (what Android's memory killers
 * weigh) and the parts most likely to grow under inference.
 */
function memoryReadings(text) {
  const kb = (pattern) => {
    const match = text.match(pattern)
    return match ? Number(match[1]) : null
  }
  const readings = [
    { metric: 'status.VmRSS', kb: kb(/^VmRSS:\s+(\d+)/m), peakKb: kb(/^VmHWM:\s+(\d+)/m) },
    { metric: 'meminfo.totalPss', kb: kb(/TOTAL PSS:\s+(\d+)/) },
    { metric: 'meminfo.swapPss', kb: kb(/TOTAL SWAP PSS:\s+(\d+)/) },
    // The App Summary rows ("Native Heap:" with a colon), whose first column is PSS.
    { metric: 'meminfo.nativeHeap', kb: kb(/^\s*Native Heap:\s+(\d+)/m) },
    { metric: 'meminfo.graphics', kb: kb(/^\s*Graphics:\s+(\d+)/m) }
  ]
  return readings
    .filter((reading) => reading.kb !== null)
    .map((reading) => ({ ...reading, peakKb: reading.peakKb ?? null }))
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
