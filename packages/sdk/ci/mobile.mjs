#!/usr/bin/env node
// The SDK's test:mobile in _mobile.yml's producer mode, as test-android-sdk.yml and test-ios-sdk.yml ran it. The build
// phase builds the consumer app with this run's id and broker baked in, and hands the group the app, a stub test package
// and the test spec. MOBILE_PHASE=produce waits for the device, drives the tests over MQTT and checks the results.

import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  copyFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  E2E,
  ROOT,
  SDK,
  compareBaseline,
  failOnFailures,
  keepResults,
  list,
  mqttCerts,
  prepare,
  run
} from './e2e.mjs'

const BUNDLE_ID = 'io.tether.test.qvac'
// The run's Device Farm job timeout, as test:mobile's jobTimeoutMinutes sets it; the spec keeps the device that long.
const DEVICE_TIMEOUT_MINUTES = 120
const PENDING = [
  'PENDING',
  'PENDING_CONCURRENCY',
  'PENDING_DEVICE',
  'PROCESSING',
  'SCHEDULING',
  'PREPARING',
  'UNKNOWN'
]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const output = (pairs) =>
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(pairs)
      .map(([k, v]) => `${k}=${v}\n`)
      .join('')
  )

export function family(app, platform) {
  if (app === 'kotlin' && platform === 'Android') return 'kotlin-android'
  if (app === 'js' && ['Android', 'iOS'].includes(platform)) {
    return platform === 'iOS' ? 'ios' : 'android'
  }
  throw new Error(`no SDK app ${app} on ${platform}`)
}

// Unique per attempt; both phases of a job compute the same one.
const runIdOf = (fam, env) => `${fam}-pr0-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || 1}`

// main's Kotlin consumer build: this commit's sdk and inference packed into packages/sdk-kotlin, then the app.
function buildKotlin(env) {
  const { ndk } = JSON.parse(readFileSync(join(ROOT, 'nx.json'), 'utf8')).targetDefaults.build
    .metadata.toolchain.android
  run('sdkmanager', [`ndk;${ndk}`], { env })
  run('git', ['checkout', '--', 'package.json'], { cwd: SDK, env })
  run('npm', ['run', 'sdk-source:workspace'], { cwd: SDK, env })
  run('npx', ['tsc', '--project', 'tsconfig.json'], { cwd: SDK, env })
  run('npm', ['run', 'postcompile:aliases'], { cwd: SDK, env })
  run('git', ['checkout', '--', 'package.json'], { cwd: SDK, env })
  const pack = (cwd) =>
    run('npm', ['pack', '--ignore-scripts', '--silent'], { cwd, env, capture: true }).trim()
  const sdkTgz = pack(SDK)
  const infTgz = pack(join(ROOT, 'packages/inference'))
  const kotlin = join(ROOT, 'packages/sdk-kotlin')
  run('npm', ['pkg', 'set', `overrides.@qvac/inference=file:../inference/${infTgz}`], {
    cwd: kotlin,
    env
  })
  run(
    'npm',
    ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-package-lock', `../sdk/${sdkTgz}`],
    { cwd: kotlin, env }
  )
  run('node', ['runners/kotlin/scripts/device.mjs', 'build', '--prebuilt-sdk'], { cwd: E2E, env })
}

function build(app, env) {
  const fam = family(app, env.PLATFORM)
  const runId = runIdOf(fam, env)
  // Device runs are the expensive place to find a second copy of a shared runtime library, so this fails first.
  if (app === 'js') {
    run(
      'node',
      [
        '.github/scripts/check-shared-runtime-libs.mjs',
        'packages/sdk',
        '--local',
        'packages/inference'
      ],
      { env }
    )
  }
  const e = { ...prepare(env), NPM_CONFIG_USERCONFIG: join(E2E, '.npmrc') }
  const ios = env.PLATFORM === 'iOS'
  // The group's IOS_SIGNING: the imported profile's UUID, its export method, and the team.
  const signing = (env.IOS_SIGNING || '').split(',')
  if (app === 'kotlin') buildKotlin(e)
  else {
    run(
      'npx',
      ['qvac-test', `build:consumer:${ios ? 'ios' : 'android'}`, '--runId', runId, '--config', '.'],
      {
        cwd: E2E,
        env: ios
          ? {
              ...e,
              QVAC_IOS_BUNDLE_ID: BUNDLE_ID,
              QVAC_IOS_TEAM_ID: signing[2],
              QVAC_IOS_CODE_SIGN_IDENTITY: 'Apple Distribution',
              QVAC_IOS_PROVISIONING_PROFILE: signing[0],
              QVAC_IOS_EXPORT_METHOD: signing[1]
            }
          : e
      }
    )
  }
  const ext = ios ? 'ipa' : 'apk'
  const app_ = join(E2E, 'build/consumers', fam, `consumer.${ext}`)
  if (!existsSync(app_)) throw new Error(`${app_} was not built`)
  // A stub test package: the device runs the app, and the producer drives it from here.
  const tmp = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'sdk-mobile-'))
  const stub = join(tmp, 'stub')
  mkdirSync(stub)
  writeFileSync(join(stub, 'package.json'), '{"name":"qvac-test-stub","version":"1.0.0"}\n')
  copyFileSync(join(E2E, 'device-farm/gen-junit.py'), join(stub, 'gen-junit.py'))
  execFileSync('zip', ['-r', join(tmp, 'qvac-test-stub.zip'), '.'], { cwd: stub, stdio: 'inherit' })
  let spec = readFileSync(
    join(E2E, `device-farm/test-spec-${ios ? 'ios' : 'android'}.yml`),
    'utf8'
  ).replace('DEVICEFARM_TIMEOUT:-5400', `DEVICEFARM_TIMEOUT:-${DEVICE_TIMEOUT_MINUTES * 60}`)
  // The spec targets the React Native app; the Kotlin app has its own activity and log tag.
  if (app === 'kotlin') {
    spec = spec
      .replaceAll(
        'io.tether.qvac_test_consumer_mobile/.MainActivity',
        'io.tether.qvac.e2e.kotlin/io.tether.qvac.e2e.MainActivity'
      )
      .replaceAll('ReactNativeJS', 'QvacE2E')
  }
  const specFile = join(tmp, `qvac-test-spec-${runId}.yml`)
  writeFileSync(specFile, spec)
  output({
    'app-path': app_,
    'app-type': ios ? 'IOS_APP' : 'ANDROID_APP',
    'app-name': `consumer-${runId}.${ext}`,
    'test-package': join(tmp, 'qvac-test-stub.zip'),
    specs: JSON.stringify([{ name: fam, file: specFile }])
  })
}

const aws = (args) =>
  JSON.parse(
    execFileSync('aws', ['devicefarm', ...args, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  )

// main's wait-for-running: the producer starts once the device runs, within 15 minutes, or the runs are stopped.
export async function waitForRunning(
  arns,
  { timeoutMinutes = 15, intervalMs = 15000, get = aws } = {}
) {
  const started = Date.now()
  for (;;) {
    const runs = arns.map((arn) => {
      try {
        return { arn, ...get(['get-run', '--arn', arn]).run }
      } catch (e) {
        return { arn, status: 'UNKNOWN', message: e.message }
      }
    })
    const line = runs
      .map((r) => `${r.arn.split('/').pop()}:${r.status}/${r.result ?? 'UNKNOWN'}`)
      .join(', ')
    console.log(`${Math.round((Date.now() - started) / 1000)}s ${line}`)
    if (runs.some((r) => r.status === 'RUNNING')) return
    if (!runs.some((r) => PENDING.includes(r.status))) {
      throw new Error(`Every Device Farm run finished before RUNNING: ${line}`)
    }
    if (Date.now() - started >= timeoutMinutes * 60000) {
      for (const r of runs) {
        try {
          get(['stop-run', '--arn', r.arn])
        } catch {}
      }
      throw new Error(
        `No Device Farm run entered RUNNING within ${timeoutMinutes} minutes: ${line}`
      )
    }
    await sleep(intervalMs)
  }
}

async function produce(app, env) {
  const fam = family(app, env.PLATFORM || (env.CONFIG === 'ios-arm64' ? 'iOS' : 'Android'))
  const runId = runIdOf(fam, env)
  const filter = list('tests', env.TESTS)
  await waitForRunning(JSON.parse(env.RUN_ARNS || '[]'))
  const e = mqttCerts(env)
  const reports = join(E2E, 'reports')
  const args = [
    'qvac-test',
    'run:producer',
    '--runId',
    runId,
    '--consumer-timeout',
    '1200',
    '--config',
    '.',
    '--report-dir=./reports',
    ...(filter ? [`--filter=${filter}`] : [])
  ]
  let failure = null
  try {
    execFileSync('npx', args, { cwd: E2E, env: e, stdio: 'inherit', timeout: 120 * 60000 })
  } catch (err) {
    failure = err
  }
  const slug = app === 'kotlin' ? 'sdk-kotlin' : 'sdk'
  keepResults(join(ROOT, 'packages', slug, 'test/results/e2e', fam), [reports])
  await compareBaseline({
    env: e,
    workflow: 'mobile-tests.yml',
    artifact: `${slug}-results-${env.CONFIG}`,
    reports,
    label: fam
  })
  failOnFailures(reports)
  if (failure) throw failure
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = process.argv[2]
  const phase = process.env.MOBILE_PHASE === 'produce' ? produce : async (a, env) => build(a, env)
  phase(app, process.env).catch((err) => {
    console.log(`::error::${err.message}`)
    process.exit(1)
  })
}
