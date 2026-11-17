import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../devicefarm-schedule-unmetered.mjs'

// statuses: run name -> list of get-run statuses, the last one repeating. fail: action -> true or (args) => boolean.
function fakeAws({ statuses = {}, fail = {} } = {}) {
  const calls = []
  const runs = new Map()
  let n = 0
  const aws = (args) => {
    const action = args[0]
    calls.push(args)
    const f = fail[action]
    if (f === true || (typeof f === 'function' && f(args))) throw new Error(`${action} failed`)
    const arg = (flag) => args[args.indexOf(flag) + 1]
    if (action === 'schedule-run') {
      const arn = `arn:run/${++n}`
      const billing = JSON.parse(arg('--configuration')).billingMethod
      runs.set(arn, { name: arg('--name'), billing, polls: 0 })
      return { run: { arn } }
    }
    if (action === 'get-run') {
      const run = runs.get(arg('--arn'))
      const list = statuses[run.name] ?? ['RUNNING']
      return { run: { status: list[Math.min(run.polls++, list.length - 1)] } }
    }
    if (action === 'list-runs') return { runs: [] }
    return {}
  }
  return { aws, calls, runs }
}

function setup(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'df-unmetered-'))
  const output = join(dir, 'output')
  writeFileSync(output, '')
  return {
    output,
    env: {
      TEST_TYPE: 'APPIUM_NODE',
      PLATFORM: 'iOS',
      PROJECT_ARN: 'arn:project',
      APP_ARN: 'arn:upload/app1',
      TEST_PACKAGE_ARN: 'arn:package',
      SPECS: JSON.stringify([{ name: 'ocr', arn: 'arn:spec/ocr' }]),
      DEVICES: 'Apple iPhone 16,Apple iPhone 17',
      OPERATOR: 'EQUALS',
      TIMEOUT: '120',
      GITHUB_EVENT_NAME: 'schedule',
      GITHUB_RUN_NUMBER: '7',
      GITHUB_RUN_ID: '99',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_OUTPUT: output,
      CHECK_SECONDS: '180',
      POLL_SECONDS: '10',
      ...env
    }
  }
}

// Each sleep moves the clock, so the deadline is reached without waiting.
function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms) => (t += ms) }
}

const outputs = (file) =>
  Object.fromEntries(
    readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(/=(.*)/s).slice(0, 2))
  )
const billingOf = (calls) =>
  calls.filter((c) => c[0] === 'schedule-run').map((c) => JSON.parse(c[c.indexOf('--configuration') + 1]).billingMethod)
const stops = (calls) => calls.filter((c) => c[0] === 'stop-run').map((c) => c[2])
const name16 = 'PR-7-iOS-99.1-app1-ocr-Apple_iPhone_16'
const name17 = 'PR-7-iOS-99.1-app1-ocr-Apple_iPhone_17'

test('runs that get a slot stay UNMETERED', async () => {
  const { env, output } = setup()
  const { aws, calls } = fakeAws({ statuses: { [name16]: ['SCHEDULING', 'PREPARING'] } })
  await main(env, { aws, ...clock() })
  assert.deepEqual(billingOf(calls), ['UNMETERED', 'UNMETERED'])
  assert.deepEqual(stops(calls), [])
  assert.deepEqual(outputs(output), {
    'run-arns': '["arn:run/1","arn:run/2"]',
    'run-count': '2',
    'metered-count': '0'
  })
})

test('PENDING_CONCURRENCY moves to METERED at once, same name and position', async () => {
  const { env, output } = setup()
  const { aws, calls, runs } = fakeAws({ statuses: { [name16]: ['PENDING_CONCURRENCY'] } })
  const c = clock()
  await main(env, { aws, ...c })
  assert.equal(c.now(), 0)
  assert.deepEqual(billingOf(calls), ['UNMETERED', 'UNMETERED', 'METERED'])
  assert.deepEqual(stops(calls), ['arn:run/1'])
  assert.equal(runs.get('arn:run/3').name, name16)
  assert.equal(outputs(output)['run-arns'], '["arn:run/3","arn:run/2"]')
  assert.equal(outputs(output)['metered-count'], '1')
})

test('a run still SCHEDULING at the deadline moves to METERED', async () => {
  const { env, output } = setup()
  const { aws, calls } = fakeAws({ statuses: { [name17]: ['SCHEDULING'] } })
  const c = clock()
  await main(env, { aws, ...c })
  assert.equal(c.now(), 180000)
  assert.deepEqual(stops(calls), ['arn:run/2'])
  assert.equal(outputs(output)['run-arns'], '["arn:run/1","arn:run/3"]')
})

test('METERED billing never polls', async () => {
  const { env, output } = setup({ BILLING_METHOD: 'metered' })
  const { aws, calls } = fakeAws({ statuses: { [name16]: ['PENDING_CONCURRENCY'] } })
  await main(env, { aws, ...clock() })
  assert.deepEqual(billingOf(calls), ['METERED', 'METERED'])
  assert.equal(calls.filter((c) => c[0] === 'get-run').length, 0)
  assert.equal(outputs(output)['metered-count'], '2')
})

test('a run that cannot be stopped is kept UNMETERED', async () => {
  const { env, output } = setup()
  const { aws, calls } = fakeAws({ statuses: { [name16]: ['PENDING_CONCURRENCY'] }, fail: { 'stop-run': true } })
  await main(env, { aws, ...clock() })
  assert.deepEqual(billingOf(calls), ['UNMETERED', 'UNMETERED'])
  assert.equal(outputs(output)['run-arns'], '["arn:run/1","arn:run/2"]')
})

test('a run whose status never reads is not stopped', async () => {
  const { env, output } = setup()
  const { aws, calls } = fakeAws({ fail: { 'get-run': (a) => a[2] === 'arn:run/1' } })
  await main(env, { aws, ...clock() })
  assert.deepEqual(stops(calls), [])
  assert.equal(outputs(output)['metered-count'], '0')
})

test('an invalid billing method fails before scheduling', async () => {
  const { env } = setup({ BILLING_METHOD: 'FREE' })
  const { aws, calls } = fakeAws()
  await assert.rejects(main(env, { aws, ...clock() }), /UNMETERED or METERED/)
  assert.equal(calls.length, 0)
})

test('a failed METERED reschedule stops every run created', async () => {
  const { env } = setup()
  let scheduled = 0
  const { aws, calls } = fakeAws({
    statuses: { [name16]: ['PENDING_CONCURRENCY'] },
    fail: { 'schedule-run': () => ++scheduled === 3 }
  })
  await assert.rejects(main(env, { aws, ...clock() }), /schedule-run failed/)
  assert.deepEqual(stops(calls), ['arn:run/1', 'arn:run/1', 'arn:run/2'])
})

test('scheduling that stops part way stops created runs and sweeps by name', async () => {
  const { env } = setup()
  let scheduled = 0
  const { aws, calls } = fakeAws({ fail: { 'schedule-run': () => ++scheduled === 2 } })
  await assert.rejects(main(env, { aws, ...clock() }))
  assert.deepEqual(stops(calls), ['arn:run/1'])
  assert.ok(calls.some((c) => c[0] === 'list-runs'))
})
