import fs from 'fs'
import path from 'path'
import test from 'brittle'
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
