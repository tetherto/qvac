import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ACTION = join(dirname(fileURLToPath(import.meta.url)), '..', 'action.yml')
const STEP = 'Wait for Device Farm runs'
const RUN_ARN = 'arn:aws:devicefarm:us-west-2:111111111111:run:project/run'
// About 0.6 s, so a test spans only a few polls.
const SHORT_WAIT_MINUTES = '0.01'

// Fake aws CLI: each get-run returns the next status in the list (the last one
// repeats), FAIL makes that call fail, and stop-run exits with FAKE_STOP_EXIT.
const FAKE_AWS = `#!/usr/bin/env bash
echo "$2" >> "$FAKE_DIR/calls"
case "$2" in
  get-run)
    n=$(grep -c '^get-run$' "$FAKE_DIR/calls")
    status=$(sed -n "\${n}p" "$FAKE_DIR/statuses")
    [ -n "$status" ] || status=$(tail -n 1 "$FAKE_DIR/statuses")
    [ "$status" = FAIL ] && exit 1
    printf '{"status":"%s","result":"PENDING"}\\n' "$status"
    ;;
  stop-run)
    exit "\${FAKE_STOP_EXIT:-0}"
    ;;
esac
`

function readStepScript() {
  const source = readFileSync(ACTION, 'utf8')
  const remainder = source.slice(source.indexOf(`- name: ${STEP}`))
  const run = remainder.match(/^([ ]*)run: \|\r?\n/m)
  assert.ok(run, `run block not found in step "${STEP}"`)
  const indentation = ' '.repeat(run[1].length + 2)
  const lines = remainder.slice(run.index + run[0].length).split(/\r?\n/)
  const end = lines.findIndex((line) => line && !line.startsWith(indentation))
  return lines
    .slice(0, end < 0 ? lines.length : end)
    .map((line) => line.slice(indentation.length))
    .join('\n')
}

function waitFor(t, { statuses, unmeteredWaitMinutes, stopExit = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-df-wait-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bin = join(dir, 'bin')
  const arns = join(dir, 'run-arns')
  mkdirSync(bin)
  mkdirSync(arns)
  writeFileSync(join(bin, 'aws'), FAKE_AWS)
  chmodSync(join(bin, 'aws'), 0o755)
  writeFileSync(join(dir, 'statuses'), `${statuses.join('\n')}\n`)
  writeFileSync(join(dir, 'calls'), '')
  writeFileSync(join(dir, 'output'), '')
  writeFileSync(join(arns, 'Pixel.txt'), `${RUN_ARN}\n`)
  writeFileSync(join(dir, 'wait.js'), readStepScript())

  const result = spawnSync(process.execPath, [join(dir, 'wait.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_DIR: dir,
      FAKE_STOP_EXIT: String(stopExit),
      GITHUB_OUTPUT: join(dir, 'output'),
      GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      PLATFORM: 'android',
      RUN_ARNS_DIRECTORY: arns,
      START_TIMEOUT_MINUTES: '1',
      POLL_INTERVAL_SECONDS: '1',
      UNMETERED_WAIT_MINUTES: unmeteredWaitMinutes,
    },
  })
  return {
    status: result.status,
    log: result.stdout + result.stderr,
    calls: readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n'),
    output: readFileSync(join(dir, 'output'), 'utf8'),
  }
}

test('a run still queued after the slot wait is stopped and reported', { skip: process.platform === 'win32' }, (t) => {
  const run = waitFor(t, { statuses: ['PENDING_CONCURRENCY'], unmeteredWaitMinutes: SHORT_WAIT_MINUTES })
  assert.equal(run.status, 0, run.log)
  assert.equal(run.output, 'slot-timeout=true\n')
  assert.deepEqual(run.calls, ['get-run', 'get-run', 'stop-run'])
})

test('the job fails when the queued run cannot be stopped', { skip: process.platform === 'win32' }, (t) => {
  const run = waitFor(t, {
    statuses: ['PENDING_CONCURRENCY'],
    unmeteredWaitMinutes: SHORT_WAIT_MINUTES,
    stopExit: 1,
  })
  assert.equal(run.status, 1, run.log)
  assert.equal(run.output, '')
})

test('a failed status read at the deadline does not stop the run', { skip: process.platform === 'win32' }, (t) => {
  // The last good read says queued, but the run got a slot meanwhile.
  const run = waitFor(t, {
    statuses: ['PENDING_CONCURRENCY', 'FAIL', 'PENDING_DEVICE', 'RUNNING'],
    unmeteredWaitMinutes: SHORT_WAIT_MINUTES,
  })
  assert.equal(run.status, 0, run.log)
  assert.equal(run.output, '')
  assert.ok(!run.calls.includes('stop-run'), run.log)
})

test('a run that got a slot is kept past the slot wait', { skip: process.platform === 'win32' }, (t) => {
  const run = waitFor(t, {
    statuses: ['PENDING_CONCURRENCY', 'PENDING_DEVICE', 'RUNNING'],
    unmeteredWaitMinutes: SHORT_WAIT_MINUTES,
  })
  assert.equal(run.status, 0, run.log)
  assert.equal(run.output, '')
  assert.ok(!run.calls.includes('stop-run'), run.log)
})

test('no slot wait applies when it is disabled', { skip: process.platform === 'win32' }, (t) => {
  const run = waitFor(t, {
    statuses: ['PENDING_CONCURRENCY', 'PENDING_CONCURRENCY', 'RUNNING'],
    unmeteredWaitMinutes: '0',
  })
  assert.equal(run.status, 0, run.log)
  assert.equal(run.output, '')
  assert.ok(!run.calls.includes('stop-run'), run.log)
})
