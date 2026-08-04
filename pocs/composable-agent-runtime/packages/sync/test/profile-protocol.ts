import path from 'path'
import test from 'brittle'
import { createSync } from '../index.ts'
import { durableWorkProfile } from '../profiles/durable-work.ts'
import { testContext } from './helpers.ts'

test('sync: profile apply is idempotent for one operation id', async (t) => {
  const { dir, testnet } = await testContext(t)
  const sync = createSync({
    storagePath: path.join(dir, 'profile-idempotent'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => sync.close())
  await sync.ready()

  const state = sync.openProfile(durableWorkProfile)
  const command = {
    type: 'record-work' as const,
    workId: 'work-1',
    payload: Buffer.from('body'),
    payloadFormat: 'text',
    payloadVersion: 1
  }
  const first = await state.apply(command, { operationId: 'op-1' })
  const second = await state.apply(command, { operationId: 'op-1' })
  t.is(second.revision, first.revision)
  await t.exception(
    state.apply(
      { ...command, payload: Buffer.from('different') },
      { operationId: 'op-1' }
    ),
    /different command/i
  )

  const listed = await state.query({ type: 'list-available-work' as const })
  t.is(listed.works.length, 1)
  t.is(listed.works.at(0)?.workId, 'work-1')

  await t.exception(
    state.apply(command, { operationId: 'duplicate-create' }),
    /invalid.*transition/i
  )
  const updated = await state.apply(
    {
      type: 'append-journal',
      workId: 'work-1',
      entryType: 'note',
      body: Buffer.from('Two')
    },
    { operationId: 'op-2', expectedRevision: first.revision }
  )
  t.is(updated.revision, 'op-2')
  await t.exception(
    state.apply(
      {
        type: 'append-journal',
        workId: 'work-1',
        entryType: 'note',
        body: Buffer.from('Stale')
      },
      { operationId: 'op-3', expectedRevision: first.revision }
    ),
    /revision conflict/i
  )
})

test('sync: profile watch emits snapshot then cursor-bearing change', async (t) => {
  const { dir, testnet } = await testContext(t)
  const sync = createSync({
    storagePath: path.join(dir, 'profile-watch'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => sync.close())
  await sync.ready()
  const state = sync.openProfile(durableWorkProfile)
  const generation = (await sync.runtime.status()).generation

  const watch = state.watch({ type: 'list-available-work' })[Symbol.asyncIterator]()
  t.teardown(() => void watch.return?.())
  const snapshot = await watch.next()
  t.is(snapshot.value.kind, 'snapshot')
  t.is(snapshot.value.generation, generation)
  t.ok(snapshot.value.cursor.length > 0)

  await state.apply(
    {
      type: 'record-work',
      workId: 'watched',
      payload: Buffer.from('x'),
      payloadFormat: 'text',
      payloadVersion: 1
    },
    { operationId: 'op-watch-1' }
  )

  const change = await watch.next()
  t.is(change.value.kind, 'change')
  t.is(change.value.generation, generation)
  t.ok(change.value.cursor !== snapshot.value.cursor)
  t.is(change.value.change.works.at(0)?.workId, 'watched')
})

test('sync: suspend terminates profile watches and rejects commands', async (t) => {
  const { dir, testnet } = await testContext(t)
  const sync = createSync({
    storagePath: path.join(dir, 'profile-suspend'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => sync.close())
  await sync.ready()
  const state = sync.openProfile(durableWorkProfile)
  const watch = state.watch({ type: 'list-available-work' })[Symbol.asyncIterator]()
  const initial = await watch.next()

  const next = watch.next()
  const ended = t.exception(next, /suspended/i)
  await sync.suspend()
  await ended
  await t.exception(
    state.apply(
      {
        type: 'record-work',
        workId: 'blocked',
        payload: Buffer.from('x'),
        payloadFormat: 'text',
        payloadVersion: 1
      },
      { operationId: 'op-blocked' }
    ),
    /suspended/i
  )
  await sync.resume()
  await t.exception(
    state.query({ type: 'list-available-work' }),
    /generation ended/i
  )
  const resumedState = sync.openProfile(durableWorkProfile)
  const resumed = resumedState.watch(
    { type: 'list-available-work' },
    { after: initial.value.cursor }
  )[Symbol.asyncIterator]()
  t.teardown(() => void resumed.return?.())
  const snapshot = await resumed.next()
  t.is(snapshot.value.kind, 'snapshot')
  t.ok(
    snapshot.value.generation !== initial.value.generation,
    'foreign-generation cursor starts a fresh snapshot'
  )
})

test('sync: stable runtime exposes durable work without a task compatibility API', async (t) => {
  const { dir, testnet } = await testContext(t)
  const sync = createSync({
    storagePath: path.join(dir, 'profile-stable'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => sync.close())
  await sync.ready()

  const profile = sync.openProfile(durableWorkProfile)
  await profile.apply(
    {
      type: 'record-work',
      workId: 'stable-1',
      payload: Buffer.from('stable'),
      payloadFormat: 'text',
      payloadVersion: 1
    },
    { operationId: 'stable-1' }
  )
  const listed = await profile.query({ type: 'list-available-work' })
  t.is(listed.works[0]?.workId, 'stable-1')
})
