'use strict'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Exercises the monitor's Device Farm retry against a fake AWS CLI: a run that
// completes as ERRORED with zero tests executed is an infrastructure failure and
// must be rescheduled exactly once, while a real FAILED result never is. Runs the
// action's own shell body, so the assertions cover the shipped code rather than a
// reimplementation of it.

const HERE = dirname(fileURLToPath(import.meta.url))
const ACTION = join(HERE, '..', 'action.yml')

const RUN_A = 'arn:aws:devicefarm:us-west-2:833707431398:run:proj-1/aaa'
const RUN_B = 'arn:aws:devicefarm:us-west-2:833707431398:run:proj-1/bbb'
const RETRY_1 = 'arn:aws:devicefarm:us-west-2:833707431398:run:proj-1/retry1'
const DERIVED_PROJECT = 'arn:aws:devicefarm:us-west-2:833707431398:project:proj-1'

const POOL_RECIPE = { name: 'PR-1-iOS-lavasr', specArn: 'arn:spec:1', poolArn: 'arn:pool:ios', filter: '' }
const FILTER_RECIPE = {
  name: 'PR-1-iOS-lavasr-iPhone17',
  specArn: 'arn:spec:1',
  poolArn: '',
  filter: '{"filters":[],"maxDevices":1}'
}
const RECIPES = JSON.stringify([POOL_RECIPE, FILTER_RECIPE])

const PASSED = 'COMPLETED PASSED 3 0 3'
const ERRORED_NO_TESTS = 'COMPLETED ERRORED 0 0 0'

// The action embeds one `run: |` block; take its body and undo the YAML indent.
function actionScript() {
  const lines = readFileSync(ACTION, 'utf8').split('\n')
  const start = lines.indexOf('      run: |')
  assert.notEqual(start, -1, 'monitor action must contain a single run block')
  return collectBlock(lines.slice(start + 1)).join('\n')
}

function collectBlock(lines) {
  const body = []
  for (const line of lines) {
    if (line.trim() !== '' && !line.startsWith('        ')) break
    body.push(line.slice(8))
  }
  return body
}

// Minimal `aws devicefarm` stand-in. Run outcomes are seeded per ARN as
// "<status> <result> <total> <failed> <passed>"; schedule-run records what it was
// asked for and seeds the replacement run's outcome.
const FAKE_AWS = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const state = process.env.FAKE_AWS_STATE
const argv = process.argv.slice(2)
const action = argv[1]
const valueOf = (flag) => {
  const at = argv.indexOf(flag)
  return at === -1 ? '' : argv[at + 1]
}
const keyFor = (arn) => arn.replace(/[^A-Za-z0-9]/g, '_')
const outcomeOf = (arn) => {
  const path = join(state, 'runs', keyFor(arn))
  const line = existsSync(path) ? readFileSync(path, 'utf8').trim() : 'COMPLETED UNKNOWN 0 0 0'
  const [status, result, total, failed, passed] = line.split(/\\s+/)
  return { status, result, total: Number(total), failed: Number(failed), passed: Number(passed) }
}

if (action === 'get-run') {
  const arn = valueOf('--arn')
  const o = outcomeOf(arn)
  process.stdout.write(JSON.stringify({
    run: {
      arn,
      name: 'run-' + arn,
      status: o.status,
      result: o.result,
      appUpload: process.env.FAKE_APP_UPLOAD || 'arn:upload:app-from-run',
      jobTimeoutMinutes: Number(process.env.FAKE_JOB_TIMEOUT || 90),
      counters: { total: o.total, failed: o.failed, passed: o.passed, errored: 0, skipped: 0 }
    }
  }))
} else if (action === 'list-jobs') {
  process.stdout.write(JSON.stringify({ jobs: [{ arn: valueOf('--arn') + '/job0' }] }))
} else if (action === 'get-job') {
  const o = outcomeOf(valueOf('--arn').replace(/\\/job0$/, ''))
  process.stdout.write(JSON.stringify({
    job: {
      device: { name: 'Fake Phone' },
      result: o.result,
      counters: { total: o.total, failed: o.failed, passed: o.passed, errored: 0, skipped: 0 }
    }
  }))
} else if (action === 'schedule-run') {
  const pool = valueOf('--device-pool-arn')
  const selector = pool ? 'pool:' + pool : 'filter:' + valueOf('--device-selection-configuration')
  const callsPath = join(state, 'schedule_calls')
  const previous = existsSync(callsPath) ? readFileSync(callsPath, 'utf8').split('\\n').filter(Boolean) : []
  appendFileSync(callsPath, valueOf('--name') + '|' + selector + '\\n')
  appendFileSync(join(state, 'schedule_params'), [
    'project=' + valueOf('--project-arn'),
    'app=' + valueOf('--app-arn'),
    'timeout=' + valueOf('--execution-configuration'),
    'test=' + valueOf('--test')
  ].join(' ') + '\\n')
  const arn = 'arn:aws:devicefarm:us-west-2:833707431398:run:proj-1/retry' + (previous.length + 1)
  const outcomePath = join(state, 'retry_outcome')
  const outcome = existsSync(outcomePath) ? readFileSync(outcomePath, 'utf8').trim() : 'COMPLETED PASSED 3 0 3'
  writeFileSync(join(state, 'runs', keyFor(arn)), outcome + '\\n')
  process.stdout.write(arn)
} else if (action === 'stop-run') {
  appendFileSync(join(state, 'stop_calls'), valueOf('--arn') + '\\n')
} else {
  process.stderr.write('fake aws: unsupported ' + argv.join(' ') + '\\n')
  process.exit(1)
}
`

function writeFakeCli(root) {
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const aws = join(bin, 'aws')
  writeFileSync(aws, FAKE_AWS)
  chmodSync(aws, 0o755)
  // The poll loop sleeps 30s between iterations; the fake keeps tests instant.
  const sleep = join(bin, 'sleep')
  writeFileSync(sleep, '#!/bin/sh\nexit 0\n')
  chmodSync(sleep, 0o755)
  return bin
}

function seedRuns(state, runs) {
  mkdirSync(join(state, 'runs'), { recursive: true })
  for (const [arn, outcome] of Object.entries(runs)) {
    writeFileSync(join(state, 'runs', arn.replace(/[^A-Za-z0-9]/g, '_')), outcome + '\n')
  }
}

function readLines(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
}

function parseOutputs(path) {
  const outputs = {}
  for (const line of readLines(path)) {
    const at = line.indexOf('=')
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1)
  }
  return outputs
}

// Only the two inputs Device Farm cannot report back; project ARN, app upload and
// job timeout are expected to be derived from the errored run itself.
const RETRY_ENV = { RUN_SPECS_JSON: RECIPES, TEST_PACKAGE_ARN: 'arn:upload:testpkg', MAX_ERRORED_RETRIES: '1' }

function runMonitor({ runs, env = {}, retryOutcome }) {
  const root = mkdtempSync(join(tmpdir(), 'monitor-retry-'))
  try {
    const state = join(root, 'state')
    seedRuns(state, runs)
    if (retryOutcome) writeFileSync(join(state, 'retry_outcome'), retryOutcome + '\n')
    const bin = writeFakeCli(root)
    const script = join(root, 'monitor.sh')
    writeFileSync(script, actionScript())
    const githubOutput = join(root, 'github_output')
    const githubSummary = join(root, 'github_summary')
    writeFileSync(githubOutput, '')
    writeFileSync(githubSummary, '')

    let status = 0
    let stdout = ''
    try {
      stdout = execFileSync('bash', [script], {
        encoding: 'utf8',
        timeout: 120000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_AWS_STATE: state,
          RUN_ARNS_JSON: JSON.stringify([RUN_A, RUN_B]),
          MAX_WAIT_TIME_SECONDS: '600',
          TEST_SPECS_JSON: '[]',
          RUN_SPECS_JSON: '[]',
          PROJECT_ARN: '',
          APP_ARN: '',
          TEST_PACKAGE_ARN: '',
          JOB_TIMEOUT_MINUTES: '',
          MAX_ERRORED_RETRIES: '1',
          GITHUB_OUTPUT: githubOutput,
          GITHUB_STEP_SUMMARY: githubSummary,
          RUNNER_TEMP: root,
          ...env
        }
      })
    } catch (error) {
      status = error.status ?? 1
      stdout = `${error.stdout ?? ''}${error.stderr ?? ''}`
    }

    return {
      status,
      stdout,
      scheduleCalls: readLines(join(state, 'schedule_calls')),
      scheduleParams: readLines(join(state, 'schedule_params')),
      stopCalls: readLines(join(state, 'stop_calls')),
      outputs: parseOutputs(githubOutput)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('an ERRORED run with zero tests executed is rescheduled once and can then pass', () => {
  const r = runMonitor({
    runs: { [RUN_A]: ERRORED_NO_TESTS, [RUN_B]: PASSED },
    env: RETRY_ENV,
    retryOutcome: PASSED
  })
  assert.deepEqual(r.scheduleCalls, ['PR-1-iOS-lavasr-retry1|pool:arn:pool:ios'])
  assert.equal(r.status, 0, r.stdout)
  assert.equal(r.outputs.test_result, 'PASSED')
  assert.equal(r.outputs.effective_run_arns, JSON.stringify([RETRY_1, RUN_B]))
})

test('the reschedule derives project, app upload and timeout from the errored run', () => {
  const r = runMonitor({
    runs: { [RUN_A]: ERRORED_NO_TESTS, [RUN_B]: PASSED },
    env: RETRY_ENV,
    retryOutcome: PASSED
  })
  const params = r.scheduleParams[0]
  // Containment, not pattern matching: the claim is that schedule-run was called
  // with these exact arguments. Building a regex here meant escaping an ARN into
  // it by hand, which is the kind of partial escaper that silently stops matching
  // what it claims to. The trailing space pins the end of the project ARN field.
  assert.ok(params.includes(`project=${DERIVED_PROJECT} `), params)
  assert.ok(params.includes('app=arn:upload:app-from-run'), params)
  assert.ok(params.includes('timeout=jobTimeoutMinutes=90'), params)
  assert.ok(params.includes('testPackageArn=arn:upload:testpkg'), params)
})

test('a FAILED run with executed tests is never rescheduled', () => {
  const r = runMonitor({ runs: { [RUN_A]: 'COMPLETED FAILED 3 1 2', [RUN_B]: PASSED }, env: RETRY_ENV })
  assert.deepEqual(r.scheduleCalls, [])
  assert.equal(r.status, 1)
})

test('an ERRORED run that executed tests is never rescheduled', () => {
  const r = runMonitor({ runs: { [RUN_A]: 'COMPLETED ERRORED 3 2 1', [RUN_B]: PASSED }, env: RETRY_ENV })
  assert.deepEqual(r.scheduleCalls, [])
  assert.equal(r.status, 1)
})

test('a rescheduled run that errors again is not rescheduled a second time', () => {
  const r = runMonitor({
    runs: { [RUN_A]: ERRORED_NO_TESTS, [RUN_B]: PASSED },
    env: RETRY_ENV,
    retryOutcome: ERRORED_NO_TESTS
  })
  assert.equal(r.scheduleCalls.length, 1)
  assert.equal(r.status, 1)
})

test('each slot is retried on its own device selection', () => {
  const r = runMonitor({
    runs: { [RUN_A]: PASSED, [RUN_B]: ERRORED_NO_TESTS },
    env: RETRY_ENV,
    retryOutcome: PASSED
  })
  assert.equal(r.scheduleCalls.length, 1)
  assert.ok(
    r.scheduleCalls[0].startsWith('PR-1-iOS-lavasr-iPhone17-retry1|filter:'),
    `slot 2 must replay its own filter recipe, got ${r.scheduleCalls[0]}`
  )
  assert.equal(r.outputs.effective_run_arns, JSON.stringify([RUN_A, RETRY_1]))
})

test('the retry stays off unless the caller supplies recipes and the test package ARN', () => {
  const r = runMonitor({ runs: { [RUN_A]: ERRORED_NO_TESTS, [RUN_B]: PASSED } })
  assert.deepEqual(r.scheduleCalls, [])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /retry: disabled/)
})

test('max-errored-retries=0 disables the retry', () => {
  const r = runMonitor({
    runs: { [RUN_A]: ERRORED_NO_TESTS, [RUN_B]: PASSED },
    env: { ...RETRY_ENV, MAX_ERRORED_RETRIES: '0' }
  })
  assert.deepEqual(r.scheduleCalls, [])
  assert.equal(r.status, 1)
})

test('a non-numeric max-errored-retries warns and disables the retry', () => {
  const r = runMonitor({
    runs: { [RUN_A]: ERRORED_NO_TESTS, [RUN_B]: PASSED },
    env: { ...RETRY_ENV, MAX_ERRORED_RETRIES: 'yes' }
  })
  assert.deepEqual(r.scheduleCalls, [])
  assert.match(r.stdout, /not a non-negative integer/)
})

test('run-specs that do not line up with the run ARNs disable the retry', () => {
  const r = runMonitor({
    runs: { [RUN_A]: ERRORED_NO_TESTS, [RUN_B]: PASSED },
    env: { ...RETRY_ENV, RUN_SPECS_JSON: JSON.stringify([POOL_RECIPE]) }
  })
  assert.deepEqual(r.scheduleCalls, [])
  assert.match(r.stdout, /recipe\(s\) for 2 run\(s\)/)
})

test('timing out with a reschedule in flight stops it and still publishes the ARNs', () => {
  const r = runMonitor({
    runs: { [RUN_A]: ERRORED_NO_TESTS, [RUN_B]: PASSED },
    env: { ...RETRY_ENV, MAX_WAIT_TIME_SECONDS: '120' },
    // The replacement never completes, so the poll loop runs out its budget.
    retryOutcome: 'RUNNING PENDING 0 0 0'
  })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /Timeout: exceeded/)
  assert.deepEqual(r.stopCalls, [RETRY_1], 'the run the monitor created must not be left billing')
  assert.equal(r.outputs.effective_run_arns, JSON.stringify([RETRY_1, RUN_B]))
})

test('timing out without any reschedule stops nothing', () => {
  const r = runMonitor({
    runs: { [RUN_A]: 'RUNNING PENDING 0 0 0', [RUN_B]: PASSED },
    env: { ...RETRY_ENV, MAX_WAIT_TIME_SECONDS: '120' }
  })
  assert.equal(r.status, 1)
  assert.deepEqual(r.stopCalls, [])
  assert.deepEqual(r.scheduleCalls, [])
})

test('every run passing leaves the retry path untouched', () => {
  const r = runMonitor({ runs: { [RUN_A]: PASSED, [RUN_B]: PASSED }, env: RETRY_ENV })
  assert.deepEqual(r.scheduleCalls, [])
  assert.equal(r.status, 0, r.stdout)
  assert.equal(r.outputs.effective_run_arns, JSON.stringify([RUN_A, RUN_B]))
})
