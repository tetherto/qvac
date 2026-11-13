import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEDULE_ACTION, makeWorkspace, runStep, spawnStep } from './composite-step.mjs'

const STEP = 'Schedule Device Farm Test Run'
const PROJECT = 'arn:aws:devicefarm:us-west-2:111111111111:project:proj'
const POOL = 'arn:aws:devicefarm:us-west-2:111111111111:devicepool:proj/pool'

// Fake aws CLI. schedule-run returns run ARNs r1, r2, ... and logs the billing
// method; get-run returns the next line of statuses/<run> (the last repeats,
// FAIL fails the call); stop-run exits FAKE_STOP_EXIT; FAKE_METERED_EXIT makes
// a METERED schedule-run fail.
const FAKE_AWS = `#!/usr/bin/env bash
cmd="$2"; shift 2
arn=""; billing=""; name=""
while [ $# -gt 0 ]; do
  case "$1" in
    --arn) arn="$2"; shift ;;
    --name) name="$2"; shift ;;
    --configuration) billing="\${2#billingMethod=}"; shift ;;
  esac
  shift
done
case "$cmd" in
  schedule-run)
    if [ "$billing" = METERED ] && [ "\${FAKE_METERED_EXIT:-0}" != 0 ]; then exit "$FAKE_METERED_EXIT"; fi
    n=$(( $(grep -c '^schedule-run' "$FAKE_DIR/calls") + 1 ))
    echo "schedule-run $billing $name r$n" >> "$FAKE_DIR/calls"
    echo "arn:aws:devicefarm:us-west-2:111111111111:run:proj/r$n"
    ;;
  get-run)
    run="\${arn##*/}"
    echo "get-run $run" >> "$FAKE_DIR/calls"
    n=$(grep -c "^get-run $run$" "$FAKE_DIR/calls")
    file="$FAKE_DIR/statuses/$run"
    [ -f "$file" ] || { echo SCHEDULING; exit 0; }
    status=$(sed -n "\${n}p" "$file")
    [ -n "$status" ] || status=$(tail -n 1 "$file")
    [ "$status" = FAIL ] && exit 1
    echo "$status"
    ;;
  stop-run)
    echo "stop-run \${arn##*/}" >> "$FAKE_DIR/calls"
    exit "\${FAKE_STOP_EXIT:-0}"
    ;;
  list-runs)
    ;;
esac
`

const SPECS = JSON.stringify([
  { name: 'groupA', arn: 'spec-a' },
  { name: 'groupB', arn: 'spec-b' },
  { name: 'groupC', arn: 'spec-c' },
])

function schedule(t, { statuses = {}, billing = 'UNMETERED', checkSeconds = '2', env = {}, specs = SPECS } = {}) {
  const ctx = makeWorkspace(t)
  const fake = join(ctx.workspace, '..', 'fake')
  const bin = join(fake, 'bin')
  mkdirSync(join(fake, 'statuses'), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(bin, 'aws'), FAKE_AWS)
  chmodSync(join(bin, 'aws'), 0o755)
  writeFileSync(join(fake, 'calls'), '')
  for (const [run, list] of Object.entries(statuses)) {
    writeFileSync(join(fake, 'statuses', run), `${list.join('\n')}\n`)
  }
  const options = {
    ...ctx,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_DIR: fake,
      PLATFORM: 'iOS',
      PROJECT_ARN: PROJECT,
      IOS_POOL_ARN: POOL,
      ANDROID_POOL_ARN: '',
      APP_ARN: 'arn:aws:devicefarm:us-west-2:111111111111:upload:proj/app1',
      TEST_PACKAGE_ARN: 'pkg',
      TEST_SPECS_JSON: specs,
      SCHEDULING_MODE: '',
      MULTI_SPEC_DUAL_FLAGSHIP: 'false',
      JOB_TIMEOUT_MINUTES: '120',
      BILLING_METHOD_INPUT: billing,
      UNMETERED_CHECK_SECONDS: checkSeconds,
      POLL_INTERVAL_SECONDS: '0',
      EVENT_NAME: 'workflow_dispatch',
      RUN_NUMBER: '7',
      PR_OR_RUN_NUMBER: '7',
      GH_RUN_ID: '100',
      GH_RUN_ATTEMPT: '1',
      ...env,
    },
  }
  const calls = () => readFileSync(join(fake, 'calls'), 'utf8').split('\n').filter(Boolean)
  return { options, calls }
}

const outputs = (text) => Object.fromEntries(text.trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)))
const runIds = (json) => JSON.parse(json).map((arn) => arn.split('/').pop())
const scheduled = (calls) => calls.filter((c) => c.startsWith('schedule-run')).map((c) => c.split(' ').slice(1).join(' '))

test('PENDING_CONCURRENCY moves a run to METERED at once, in its place', (t) => {
  const { options, calls } = schedule(t, {
    statuses: { r1: ['RUNNING'], r2: ['PENDING_CONCURRENCY'], r3: ['SCHEDULING', 'SCHEDULING', 'PREPARING'] },
  })
  const out = outputs(runStep(SCHEDULE_ACTION, STEP, options))
  assert.deepEqual(runIds(out.run_arns), ['r1', 'r4', 'r3'])
  assert.equal(out.run_count, '3')
  assert.equal(out.metered_count, '1')
  const names = scheduled(calls())
  assert.equal(names.length, 4)
  assert.ok(names.slice(0, 3).every((c) => c.startsWith('UNMETERED ')))
  assert.match(names[3], /^METERED Manual-7-iOS-100\.1-app1-groupB r4$/)
  assert.deepEqual(calls().filter((c) => c.startsWith('stop-run')), ['stop-run r2'])
  assert.match(readFileSync(options.summary, 'utf8'), /\| METERED \| 1 \|/)
})

// Device Farm reports a run queued for an unmetered slot as SCHEDULING, so a
// run that never reaches PREPARING/RUNNING by the deadline has no slot.
test('a run still SCHEDULING or PENDING at the deadline is moved to METERED', (t) => {
  const { options, calls } = schedule(t, {
    statuses: { r1: ['RUNNING'], r2: ['SCHEDULING'], r3: ['PENDING'] },
    checkSeconds: '1',
  })
  const out = outputs(runStep(SCHEDULE_ACTION, STEP, options))
  assert.deepEqual(runIds(out.run_arns), ['r1', 'r4', 'r5'])
  assert.equal(out.metered_count, '2')
  assert.deepEqual(calls().filter((c) => c.startsWith('stop-run')), ['stop-run r2', 'stop-run r3'])
})

test('runs that reach PREPARING or RUNNING in time stay UNMETERED and nothing is stopped', (t) => {
  const { options, calls } = schedule(t, {
    statuses: { r1: ['RUNNING'], r2: ['SCHEDULING', 'PREPARING'], r3: ['PENDING', 'SCHEDULING', 'RUNNING'] },
  })
  const out = outputs(runStep(SCHEDULE_ACTION, STEP, options))
  assert.deepEqual(runIds(out.run_arns), ['r1', 'r2', 'r3'])
  assert.equal(out.metered_count, '0')
  assert.equal(calls().filter((c) => c.startsWith('stop-run')).length, 0)
})

test('METERED schedules pay-as-you-go once and never checks for slots', (t) => {
  const { options, calls } = schedule(t, { billing: 'metered' })
  const out = outputs(runStep(SCHEDULE_ACTION, STEP, options))
  assert.equal(out.metered_count, '3')
  assert.ok(scheduled(calls()).every((c) => c.startsWith('METERED ')))
  assert.equal(calls().filter((c) => c.startsWith('get-run')).length, 0)
})

test('a failed stop keeps the queued UNMETERED run and schedules nothing else', (t) => {
  const { options, calls } = schedule(t, {
    statuses: { r1: ['PENDING_CONCURRENCY'], r2: ['RUNNING'], r3: ['RUNNING'] },
    env: { FAKE_STOP_EXIT: '1' },
  })
  const out = outputs(runStep(SCHEDULE_ACTION, STEP, options))
  assert.deepEqual(runIds(out.run_arns), ['r1', 'r2', 'r3'])
  assert.equal(out.metered_count, '0')
  assert.equal(scheduled(calls()).length, 3)
})

test('a run whose status could never be read is not stopped at the deadline', (t) => {
  const { options, calls } = schedule(t, {
    statuses: { r1: ['FAIL'], r2: ['RUNNING'], r3: ['RUNNING'] },
    checkSeconds: '1',
  })
  const out = outputs(runStep(SCHEDULE_ACTION, STEP, options))
  assert.deepEqual(runIds(out.run_arns), ['r1', 'r2', 'r3'])
  assert.equal(out.metered_count, '0')
  assert.equal(calls().filter((c) => c.startsWith('stop-run')).length, 0)
})

test('an invalid billing method fails before anything is scheduled', (t) => {
  const { options, calls } = schedule(t, { billing: 'FREE' })
  const result = spawnStep(SCHEDULE_ACTION, STEP, options)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /billing-method must be UNMETERED or METERED/)
  assert.equal(calls().length, 0)
})

test('a failed METERED reschedule fails the step and stops every run it created', (t) => {
  const { options, calls } = schedule(t, {
    statuses: { r1: ['PENDING_CONCURRENCY'], r2: ['RUNNING'], r3: ['RUNNING'] },
    env: { FAKE_METERED_EXIT: '255' },
  })
  const result = spawnStep(SCHEDULE_ACTION, STEP, options)
  assert.notEqual(result.status, 0)
  const stopped = calls().filter((c) => c.startsWith('stop-run')).map((c) => c.split(' ')[1])
  assert.deepEqual([...new Set(stopped)].sort(), ['r1', 'r2', 'r3'])
})
