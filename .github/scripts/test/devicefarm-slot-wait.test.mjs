// main's slot-wait tests (#5429), against the contract's devicefarm-pool-run.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { slotTimedOut, stopAndWait } from '../devicefarm-pool-run.mjs'

// A fake `aws devicefarm`: each get-run returns the next status (the last repeats); 'FAIL' makes that read throw.
function fake(statuses) {
  const calls = []
  let n = 0
  const aws = (args) => {
    calls.push(args[0])
    if (args[0] === 'stop-run') return {}
    const status = statuses[Math.min(n++, statuses.length - 1)]
    if (status === 'FAIL') throw new Error('throttled')
    return { run: { status } }
  }
  return { aws, calls }
}

test('a run that gets an UNMETERED slot is never stopped', async () => {
  const { aws, calls } = fake(['PENDING', 'PENDING_CONCURRENCY', 'RUNNING'])
  assert.equal(await slotTimedOut('arn', aws, { minutes: 1, intervalMs: 0 }), false)
  assert.ok(!calls.includes('stop-run'))
})

test('a run still queued after the slot wait is stopped so it can go METERED', async () => {
  const { aws, calls } = fake(['PENDING_CONCURRENCY'])
  assert.equal(await slotTimedOut('arn', aws, { minutes: 0, intervalMs: 0 }), true)
  assert.deepEqual(calls, ['get-run', 'stop-run'])
})

test('a failed read never decides the slot wait', async () => {
  const { aws, calls } = fake(['FAIL', 'FAIL', 'RUNNING'])
  assert.equal(await slotTimedOut('arn', aws, { minutes: 0, intervalMs: 0 }), false)
  assert.ok(!calls.includes('stop-run'))
})

test('cleanup stops queued runs too, so they never take a slot later', async () => {
  for (const status of ['PENDING', 'PENDING_CONCURRENCY', 'SCHEDULING', 'RUNNING']) {
    const { aws, calls } = fake([status, 'COMPLETED'])
    await stopAndWait(['arn'], aws, { intervalMs: 0 })
    assert.ok(calls.includes('stop-run'), status)
  }
  const { aws, calls } = fake(['COMPLETED'])
  await stopAndWait(['arn'], aws, { intervalMs: 0 })
  assert.ok(!calls.includes('stop-run'))
})
