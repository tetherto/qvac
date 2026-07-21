import path from 'path'
import test from 'brittle'
import crypto from 'hypercore-crypto'
import { openPair, testContext, waitFor } from './helpers.ts'

test('sync: a passive peer receives task profiles over an isolated DHT testnet', async (t) => {
  t.timeout(120_000)
  const { dir, testnet } = await testContext(t)
  const meshSeed = crypto.randomBytes(32)
  const creator = await openPair(t, {
    storagePath: path.join(dir, 'creator'),
    bootstrap: testnet.bootstrap,
    meshSeed
  })
  const peer = await openPair(t, {
    storagePath: path.join(dir, 'peer'),
    bootstrap: testnet.bootstrap,
    meshSeed,
    meshKey: creator.core.meshKey
  })

  const connected = await waitFor(() => creator.core.peerCount > 0 && peer.core.peerCount > 0)
  t.ok(connected, 'the real Hyperswarms connected')

  const created = await creator.client.createTask({
    id: 'replicated-task',
    title: 'Replicate me',
    input: 'from creator'
  })
  const replicated = await waitFor(async () => {
    const tasks = await peer.client.listTasks()
    return tasks.tasks.find((task) => task.id === created.id)
  })
  t.alike(replicated, created)
  await t.exception(
    peer.client.createTask({ id: 'rejected', title: 'Passive', input: 'read only' }),
    /read-only/i
  )
})

test('sync: a restarted passive peer catches up after an offline interval', async (t) => {
  t.timeout(120_000)
  const { dir, testnet } = await testContext(t)
  const meshSeed = crypto.randomBytes(32)
  const creator = await openPair(t, {
    storagePath: path.join(dir, 'creator'),
    bootstrap: testnet.bootstrap,
    meshSeed
  })
  const peerStorage = path.join(dir, 'peer')
  const peerOptions = {
    storagePath: peerStorage,
    bootstrap: testnet.bootstrap,
    meshSeed,
    meshKey: creator.core.meshKey
  }
  const peer = await openPair(t, peerOptions)
  t.ok(await waitFor(() => peer.core.peerCount > 0), 'peer connected before interruption')
  await peer.close()

  await creator.client.createTask({
    id: 'while-offline',
    title: 'Catch up',
    input: 'created during disconnect'
  })

  const reconnected = await openPair(t, peerOptions)
  const caughtUp = await waitFor(async () => {
    const tasks = await reconnected.client.listTasks()
    return tasks.tasks.some((task) => task.id === 'while-offline')
  })
  t.ok(caughtUp, 'the reopened peer replicated changes missed while offline')
})
