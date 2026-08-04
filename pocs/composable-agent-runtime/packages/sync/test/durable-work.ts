import path from 'path'
import test from 'brittle'
import crypto from 'hypercore-crypto'
import { createSync } from '../index.ts'
import { durableWorkProfile } from '../profiles/durable-work.ts'
import { testContext, waitFor } from './helpers.ts'

test('sync: durable-work persists ledger state through reopen', async (t) => {
  const { dir, testnet } = await testContext(t)
  const storagePath = path.join(dir, 'durable-work')
  const first = createSync({ storagePath, bootstrap: testnet.bootstrap })
  await first.ready()
  const state = first.openProfile(durableWorkProfile)

  await state.apply(
    {
      type: 'record-work',
      workId: 'work-1',
      payload: Buffer.from('{"run":1}'),
      payloadFormat: 'application/json',
      payloadVersion: 1
    },
    { operationId: 'work-create-1' }
  )
  await state.apply(
    {
      type: 'append-journal',
      workId: 'work-1',
      entryType: 'progress',
      body: Buffer.from('10')
    },
    { operationId: 'work-event-1' }
  )
  await state.apply(
    {
      type: 'save-checkpoint-ref',
      workId: 'work-1',
      checkpointId: 'checkpoint-1',
      format: 'qvac.agents.checkpoint',
      version: 1,
      blobRef: 'blob:checkpoint-1'
    },
    { operationId: 'work-checkpoint-1' }
  )
  await state.apply(
    {
      type: 'record-outcome',
      workId: 'work-1',
      status: 'completed',
      result: Buffer.from('ok')
    },
    { operationId: 'work-outcome-1' }
  )
  await first.close()

  const second = createSync({ storagePath, bootstrap: testnet.bootstrap })
  t.teardown(() => second.close())
  await second.ready()
  const reopened = second.openProfile(durableWorkProfile)
  const work = await reopened.query({ type: 'get-work', workId: 'work-1' })
  t.is(work.work?.workId, 'work-1')
  t.is(work.work?.outcomeStatus, 'completed')
  t.alike(work.work?.outcomeResult, Buffer.from('ok'))
  const allWork = await reopened.query({ type: 'list-work' })
  t.alike(allWork.works.map(({ workId }) => workId), ['work-1'])
  const checkpoint = await reopened.query({
    type: 'get-checkpoint-ref',
    workId: 'work-1'
  })
  t.is(checkpoint.checkpoint?.checkpointId, 'checkpoint-1')
  const journal = await reopened.query({
    type: 'list-journal',
    workId: 'work-1'
  })
  t.is(journal.entries.length, 1)
  t.alike(journal.entries[0]?.body, Buffer.from('10'))
  await t.exception(
    reopened.apply(
      {
        type: 'record-outcome',
        workId: 'work-1',
        status: 'failed',
        result: Buffer.from('late')
      },
      { operationId: 'work-outcome-late' }
    ),
    /invalid.*transition/i
  )
  await t.exception(
    reopened.apply(
      { type: 'request-cancel', workId: 'work-1', reason: 'too late' },
      { operationId: 'work-cancel-late' }
    ),
    /invalid.*transition/i
  )
  const terminal = await reopened.query({ type: 'get-work', workId: 'work-1' })
  t.is(terminal.work?.outcomeStatus, 'completed')
  t.is(terminal.work?.cancelRequested, false)
})

test('sync: durable-work cancellation is durable and idempotent', async (t) => {
  const { dir, testnet } = await testContext(t)
  const sync = createSync({
    storagePath: path.join(dir, 'durable-cancel'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => sync.close())
  await sync.ready()
  const state = sync.openProfile(durableWorkProfile)
  await state.apply(
    {
      type: 'record-work',
      workId: 'work-2',
      payload: Buffer.from('x'),
      payloadFormat: 'text/plain',
      payloadVersion: 1
    },
    { operationId: 'cancel-create' }
  )
  const first = await state.apply(
    { type: 'request-cancel', workId: 'work-2', reason: 'user' },
    { operationId: 'cancel-request' }
  )
  const second = await state.apply(
    { type: 'request-cancel', workId: 'work-2', reason: 'user' },
    { operationId: 'cancel-request' }
  )
  t.is(second.revision, first.revision)
  const work = await state.query({ type: 'get-work', workId: 'work-2' })
  t.is(work.work?.cancelRequested, true)
  t.is(work.work?.cancelReason, 'user')
})

test('sync: durable-work replicates to a real passive peer', async (t) => {
  t.timeout(120_000)
  const { dir, testnet } = await testContext(t)
  const meshSeed = crypto.randomBytes(32)
  const creator = createSync({
    storagePath: path.join(dir, 'durable-creator'),
    bootstrap: testnet.bootstrap,
    meshSeed
  })
  t.teardown(() => creator.close())
  await creator.ready()
  const creatorMesh = await creator.mesh.status()
  if (!creatorMesh.meshKey) throw new Error('Creator mesh key is unavailable')

  const peer = createSync({
    storagePath: path.join(dir, 'durable-peer'),
    bootstrap: testnet.bootstrap,
    meshSeed,
    meshKey: creatorMesh.meshKey
  })
  t.teardown(() => peer.close())
  await peer.ready()

  await creator.openProfile(durableWorkProfile).apply(
    {
      type: 'record-work',
      workId: 'replicated-work',
      payload: Buffer.from('peer'),
      payloadFormat: 'text/plain',
      payloadVersion: 1
    },
    { operationId: 'replicated-create' }
  )

  const replicated = await waitFor(async () => {
    const result = await peer
      .openProfile(durableWorkProfile)
      .query({ type: 'get-work', workId: 'replicated-work' })
    return result.work?.workId === 'replicated-work' ? result : null
  })
  t.is(replicated?.work?.workId, 'replicated-work')
})
