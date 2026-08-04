import fs from 'fs'
import path from 'path'
import test from 'brittle'
import { SyncCore } from '../lib/core.ts'
import { durableWorkProfile } from '../profiles/durable-work.ts'
import { openPair, testContext } from './helpers.ts'

test('sync: typed profiles and watches work without peers', async (t) => {
  const { dir, testnet } = await testContext(t)
  const { client } = await openPair(t, {
    storagePath: path.join(dir, 'offline'),
    bootstrap: testnet.bootstrap
  })

  const profile = client.openProfile(durableWorkProfile)
  const changes = profile
    .watch({ type: 'list-work' })
    [Symbol.asyncIterator]()
  t.alike((await changes.next()).value?.value?.works, [])
  await profile.apply(
    {
      type: 'record-work',
      workId: 'offline-work',
      payload: Buffer.from('local'),
      payloadFormat: 'text/plain',
      payloadVersion: 1
    },
    { operationId: 'offline-create' }
  )
  t.is(
    (await profile.query({ type: 'get-work', workId: 'offline-work' }))
      .work?.workId,
    'offline-work'
  )
  const changed = (await changes.next()).value
  t.is(changed?.kind, 'change')
  t.is(
    changed?.kind === 'change'
      ? changed.change.works[0]?.workId
      : undefined,
    'offline-work'
  )
  await changes.return?.()
})

test('sync: cryptographic identity and profile state survive restart', async (t) => {
  const { dir, testnet } = await testContext(t)
  const storagePath = path.join(dir, 'restart')

  const first = await openPair(t, { storagePath, bootstrap: testnet.bootstrap })
  const firstIdentity = await first.client.getIdentity()
  await first.client.openProfile(durableWorkProfile).apply(
    {
      type: 'record-work',
      workId: 'persistent-work',
      payload: Buffer.from('persistent'),
      payloadFormat: 'text/plain',
      payloadVersion: 1
    },
    { operationId: 'persistent-create' }
  )
  await first.close()

  const second = await openPair(t, { storagePath, bootstrap: testnet.bootstrap })
  t.alike(await second.client.getIdentity(), firstIdentity)
  t.is(
    (
      await second.client
        .openProfile(durableWorkProfile)
        .query({ type: 'get-work', workId: 'persistent-work' })
    ).work?.workId,
    'persistent-work'
  )
  await second.close()

  fs.rmSync(storagePath, { recursive: true, force: true })
  t.absent(fs.existsSync(storagePath), 'closed storage can be removed completely')
})

test('sync: owns a nested resource tree with dependency-safe lifecycle', async (t) => {
  const { dir, testnet } = await testContext(t)
  const core = new SyncCore({
    storagePath: path.join(dir, 'nested-tree'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => core.close())

  await core.ready()
  t.alike(
    core.inspect().map(({ name, state, deps }) => ({ name, state, deps })),
    [
      { name: 'local-metadata-store', state: 'running', deps: [] },
      { name: 'identity-corestore', state: 'running', deps: [] },
      {
        name: 'replicated-mesh-network',
        state: 'running',
        deps: ['local-metadata-store', 'identity-corestore']
      }
    ],
    'the real Sync resources are visible as canonical Supervisor children'
  )

  await core.close()
  t.alike(
    core.inspect().map(({ name, state }) => ({ name, state })),
    [
      { name: 'local-metadata-store', state: 'stopped' },
      { name: 'identity-corestore', state: 'stopped' },
      { name: 'replicated-mesh-network', state: 'stopped' }
    ],
    'closing Sync stops every nested child'
  )
})
