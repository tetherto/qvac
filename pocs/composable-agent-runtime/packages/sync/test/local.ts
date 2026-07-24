import fs from 'fs'
import path from 'path'
import test from 'brittle'
import { SyncCore } from '../lib/core.ts'
import { openPair, testContext } from './helpers.ts'

test('sync: local CRUD and watches work without peers', async (t) => {
  const { dir, testnet } = await testContext(t)
  const { client } = await openPair(t, {
    storagePath: path.join(dir, 'offline'),
    bootstrap: testnet.bootstrap
  })

  t.alike(await client.getUserProfile(), { profile: null })
  t.alike(await client.setUserProfile({ name: 'Ada' }), { name: 'Ada' })

  const users = client.watchUserProfile()[Symbol.asyncIterator]()
  t.alike((await users.next()).value, { profile: { name: 'Ada' } })
  await client.setUserProfile({ name: 'Grace' })
  t.alike((await users.next()).value, { profile: { name: 'Grace' } })
  await users.return?.()

  const created = await client.createTask({
    id: 'task-1',
    title: 'Offline task',
    input: 'work locally'
  })
  t.is(created.status, 'pending')
  t.alike((await client.listTasks()).tasks, [created])

  const tasks = client.watchTasks()[Symbol.asyncIterator]()
  t.alike((await tasks.next()).value, { tasks: [created] })
  const completed = await client.updateTask({
    id: created.id,
    status: 'completed',
    result: 'done'
  })
  t.is(completed.result, 'done')
  t.alike((await tasks.next()).value, { tasks: [completed] })
  await tasks.return?.()
})

test('sync: cryptographic device identity and local profile survive restart', async (t) => {
  const { dir, testnet } = await testContext(t)
  const storagePath = path.join(dir, 'restart')

  const first = await openPair(t, { storagePath, bootstrap: testnet.bootstrap })
  const firstIdentity = await first.client.getIdentity()
  await first.client.setUserProfile({ name: 'Persistent user' })
  await first.close()

  const second = await openPair(t, { storagePath, bootstrap: testnet.bootstrap })
  t.alike(await second.client.getIdentity(), firstIdentity)
  t.alike(await second.client.getUserProfile(), { profile: { name: 'Persistent user' } })
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
