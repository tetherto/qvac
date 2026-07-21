import path from 'path'
import test from 'brittle'
import crypto from 'hypercore-crypto'
import { SyncCore } from '../lib/core.ts'
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

test('sync: rejected pairing leaves the candidate read-only', async (t) => {
  t.timeout(120_000)
  const { dir, testnet } = await testContext(t)
  const host = await openPair(t, {
    storagePath: path.join(dir, 'host'),
    bootstrap: testnet.bootstrap
  })
  const { invite } = await host.client.createPairingInvite()
  const requests = host.client.watchPairingRequests()[Symbol.asyncIterator]()
  t.alike((await requests.next()).value, { requests: [] })

  const candidate = new SyncCore({
    storagePath: path.join(dir, 'candidate'),
    bootstrap: testnet.bootstrap,
    pairingInvite: invite
  })
  t.teardown(() => candidate.close())
  const opening = candidate.ready()
  const pending = await requests.next()
  t.is(pending.value.requests.length, 1)
  t.is(pending.value.requests[0].status, 'pending')
  t.ok(
    /^[0-9a-f]{12}:[0-9a-f]{12}$/.test(pending.value.requests[0].fingerprint),
    'host sees a redacted writer fingerprint'
  )
  t.absent(
    Object.hasOwn(pending.value.requests[0], 'invite'),
    'approval events never expose invite secrets'
  )
  t.alike(
    Object.keys(pending.value.requests[0]).sort(),
    ['fingerprint', 'id', 'status', 'writerKey'],
    'approval snapshots expose only review-safe writer metadata'
  )
  t.is(candidate.writable, false, 'candidate is not writable before host approval')

  const rejected = await host.client.rejectPairingRequest({
    id: pending.value.requests[0].id
  })
  t.is(rejected.status, 'rejected')
  await t.exception(opening, /rejected/i)
  t.is(candidate.writable, false, 'rejected candidate remains read-only')
  await requests.return?.()
})

test('sync: approval admits a phone writer and desktop updates preserve its origin', async (t) => {
  t.timeout(120_000)
  const { dir, testnet } = await testContext(t)
  const host = await openPair(t, {
    storagePath: path.join(dir, 'desktop'),
    bootstrap: testnet.bootstrap
  })
  const { invite } = await host.client.createPairingInvite()
  const requests = host.client.watchPairingRequests()[Symbol.asyncIterator]()
  await requests.next()

  const joining = openPair(t, {
    storagePath: path.join(dir, 'phone'),
    bootstrap: testnet.bootstrap,
    pairingInvite: invite
  })
  const pending = (await requests.next()).value.requests[0]
  t.is(pending.status, 'pending')
  const approved = await host.client.approvePairingRequest({ id: pending.id })
  t.is(approved.status, 'approved')

  const phone = await joining
  t.ok(phone.core.writable, 'paired core is writable before ready resolves')
  t.ok(
    await waitFor(() => host.core.peerCount > 0 && phone.core.peerCount > 0),
    'approved peers connect to the mesh'
  )

  const created = await phone.client.createTask({
    id: 'phone-origin',
    title: 'From phone',
    input: 'run this on desktop'
  })
  const desktopCopy = await waitFor(async () => {
    const result = await host.client.getTask({ id: created.id })
    return result.task
  })
  t.alike(desktopCopy, created, 'phone-created task replicates to desktop')

  const completed = await host.client.updateTask({
    id: created.id,
    status: 'completed',
    result: 'desktop result'
  })
  t.alike(completed.originDeviceId, created.originDeviceId, 'task origin is immutable')
  const phoneCopy = await waitFor(async () => {
    const result = await phone.client.getTask({ id: created.id })
    return result.task?.status === 'completed' ? result.task : null
  })
  t.alike(phoneCopy, completed, 'desktop update replicates back to phone')
  await requests.return?.()

  const reused = new SyncCore({
    storagePath: path.join(dir, 'reused-invite'),
    bootstrap: testnet.bootstrap,
    pairingInvite: invite
  })
  t.teardown(() => reused.close())
  await t.exception(reused.ready(), /used|rejected/i)
  t.is(reused.writable, false, 'consumed invite cannot admit another writer')
})

test('sync: malformed pairing invites fail deterministically without logging secret data', async (t) => {
  const { dir, testnet } = await testContext(t)
  const malformedInvite = Buffer.from('not-a-valid-pairing-invite')
  const logged: unknown[][] = []
  const originalConsoleError = console.error
  console.error = (...values: unknown[]) => {
    logged.push(values)
  }

  const candidate = new SyncCore({
    storagePath: path.join(dir, 'malformed'),
    bootstrap: testnet.bootstrap,
    pairingInvite: malformedInvite,
    logging: { level: 'error' }
  })
  t.teardown(() => candidate.close())
  let message = ''
  try {
    await candidate.ready()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  } finally {
    console.error = originalConsoleError
  }

  t.is(message, 'Pairing invite is invalid')
  const output = logged.flat().map(String).join(' ')
  t.absent(output.includes(malformedInvite.toString('hex')), 'logs omit invite bytes')
  t.absent(output.includes('meshSeed'), 'logs omit mesh seed data')
  t.absent(output.includes('encryptionKey'), 'logs omit encryption data')
})

test('sync: expired pairing invites fail before creating approval requests', async (t) => {
  const { dir, testnet } = await testContext(t)
  const host = await openPair(t, {
    storagePath: path.join(dir, 'expiry-host'),
    bootstrap: testnet.bootstrap
  })
  const created = await host.client.createPairingInvite({ expiresInMs: 1_000 })
  t.ok(created.expiresAt > Date.now(), 'invite reports its explicit expiration')
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, created.expiresAt - Date.now() + 10))
  )

  const requests = host.client.watchPairingRequests()[Symbol.asyncIterator]()
  t.alike((await requests.next()).value, { requests: [] })
  const candidate = new SyncCore({
    storagePath: path.join(dir, 'expired'),
    bootstrap: testnet.bootstrap,
    pairingInvite: created.invite
  })
  t.teardown(() => candidate.close())
  await t.exception(candidate.ready(), /Pairing invite has expired/)
  t.is(candidate.writable, false, 'expired invite never makes the candidate writable')
  await requests.return?.()
})
