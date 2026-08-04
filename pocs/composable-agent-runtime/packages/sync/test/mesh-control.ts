import path from 'path'
import test from 'brittle'
import { createSync } from '../index.ts'
import { durableWorkProfile } from '../profiles/durable-work.ts'
import { testContext, waitFor } from './helpers.ts'

test('sync: preferred mesh API dynamically joins and leaves a mesh', async (t) => {
  t.timeout(120_000)
  const { dir, testnet } = await testContext(t)
  const host = createSync({
    storagePath: path.join(dir, 'mesh-host'),
    bootstrap: testnet.bootstrap
  })
  const guest = createSync({
    storagePath: path.join(dir, 'mesh-guest'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => Promise.allSettled([guest.close(), host.close()]))
  await Promise.all([host.ready(), guest.ready()])
  const networkBefore = (await guest.runtime.diagnostics()).children.find(
    ({ name }) => name === 'replicated-mesh-network'
  )?.info?.networkInstanceId
  t.ok(networkBefore, 'join starts with one supervised network resource')
  const guestBefore = await guest.mesh.status()
  const guestPrivateProfile = guest.openProfile(durableWorkProfile)
  const invite = await host.mesh.createInvite({ expiresInMs: 60_000 })

  const requests = host.mesh.watchPairingRequests()[Symbol.asyncIterator]()
  t.teardown(() => void requests.return?.())
  const joining = guest.mesh.join(invite.invite)
  const pending = await waitFor(async () => {
    const next = await requests.next()
    return (
      next.value?.requests.find(
        ({ status }: { readonly status: string }) => status === 'pending'
      ) ?? null
    )
  })
  t.ok(pending, 'host receives a dynamic join request')
  if (!pending) throw new Error('Host did not receive a join request')
  await t.exception(guest.mesh.leave(), /membership transition/i)
  await t.exception(guest.suspend(), /membership transition/i)
  await host.mesh.approvePairingRequest(pending.id)
  await joining

  const guestJoined = await guest.mesh.status()
  const networkAfter = (await guest.runtime.diagnostics()).children.find(
    ({ name }) => name === 'replicated-mesh-network'
  )?.info?.networkInstanceId
  t.is(
    networkAfter,
    networkBefore,
    'candidate mesh activates without restarting the network resource'
  )
  await t.exception(
    guestPrivateProfile.query({ type: 'list-available-work' }),
    /generation ended/i
  )
  t.ok(guestJoined.writable, 'approved guest becomes writable')
  t.alike(guestJoined.meshKey, (await host.mesh.status()).meshKey)
  const connected = await waitFor(
    async () =>
      (await host.mesh.status()).peerCount > 0 &&
      (await guest.mesh.status()).peerCount > 0
  )
  t.ok(connected, 'joined runtimes connect on the new mesh')

  const hostProfile = host.openProfile(durableWorkProfile)
  const guestProfile = guest.openProfile(durableWorkProfile)
  await guestProfile.apply(
    {
      type: 'record-work',
      workId: 'joined-work',
      payload: Buffer.from('mesh'),
      payloadFormat: 'text',
      payloadVersion: 1
    },
    { operationId: 'joined-work-create' }
  )
  const replicated = await waitFor(async () => {
    const result = await hostProfile.query({ type: 'list-available-work' })
    return result.works.some(({ workId }) => workId === 'joined-work')
  })
  t.ok(replicated, 'joined writer replicates profile state')

  const raced = await Promise.allSettled([
    hostProfile.apply(
      {
        type: 'append-journal',
        workId: 'joined-work',
        entryType: 'race',
        body: Buffer.from('Host winner')
      },
      {
        operationId: 'race-host',
        expectedRevision: 'joined-work-create'
      }
    ),
    guestProfile.apply(
      {
        type: 'append-journal',
        workId: 'joined-work',
        entryType: 'race',
        body: Buffer.from('Guest winner')
      },
      {
        operationId: 'race-guest',
        expectedRevision: 'joined-work-create'
      }
    )
  ])
  t.ok(
    raced.some(({ status }) => status === 'fulfilled'),
    'at least one concurrent revision wins locally'
  )
  const converged = await waitFor(async () => {
    const [hostState, guestState] = await Promise.all([
      hostProfile.query({ type: 'list-journal', workId: 'joined-work' }),
      guestProfile.query({ type: 'list-journal', workId: 'joined-work' })
    ])
    const hostTitle = hostState.entries.at(-1)?.body.toString()
    const guestTitle = guestState.entries.at(-1)?.body.toString()
    return hostTitle && hostTitle === guestTitle ? hostTitle : null
  })
  t.ok(
    converged === 'Host winner' || converged === 'Guest winner',
    'concurrent expectedRevision updates converge to one winner'
  )
  const winnerRevision =
    converged === 'Host winner' ? 'race-host' : 'race-guest'
  const staleRevision =
    winnerRevision === 'race-host' ? 'race-guest' : 'race-host'
  await hostProfile.apply(
    {
      type: 'append-journal',
      workId: 'joined-work',
      entryType: 'race',
      body: Buffer.from('Fenced follow-up')
    },
    { operationId: 'race-follow-up', expectedRevision: winnerRevision }
  )
  await t.exception(
    guestProfile.apply(
      {
        type: 'append-journal',
        workId: 'joined-work',
        entryType: 'race',
        body: Buffer.from('Stale follow-up')
      },
      { operationId: 'race-stale', expectedRevision: staleRevision }
    ),
    /revision conflict/i
  )

  await guest.mesh.leave()
  const guestLeft = await guest.mesh.status()
  t.ok(
    guestLeft.meshKey &&
      guestJoined.meshKey &&
      !guestLeft.meshKey.equals(guestJoined.meshKey),
    'leave creates a fresh mesh'
  )
  t.ok(guestLeft.writable, 'fresh local mesh remains writable')
  t.ok(
    guestLeft.meshKey &&
      guestBefore.meshKey &&
      !guestLeft.meshKey.equals(guestBefore.meshKey),
    'join and leave replace membership'
  )
})

test('sync: mesh status watch follows runtime suspend and resume', async (t) => {
  const { dir, testnet } = await testContext(t)
  const sync = createSync({
    storagePath: path.join(dir, 'mesh-status-watch'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => sync.close())
  await sync.ready()

  const watch = sync.mesh.watchStatus()[Symbol.asyncIterator]()
  t.teardown(() => void watch.return?.())
  const initial = await watch.next()
  t.is(initial.value?.state, 'joined')
  const generation = initial.value?.generation
  await sync.suspend()
  t.is((await watch.next()).value?.network, 'stopped')
  await sync.resume()
  const resumed = await watch.next()
  t.is(resumed.value?.state, 'joined')
  t.is(
    resumed.value?.generation,
    String(Number(generation) + 1),
    'resume advances the watched generation'
  )
})

test('sync: removing a device revokes its writer and remints that peer', async (t) => {
  t.timeout(60_000)
  const { dir, testnet } = await testContext(t)
  const host = createSync({
    storagePath: path.join(dir, 'remove-host'),
    bootstrap: testnet.bootstrap
  })
  const guest = createSync({
    storagePath: path.join(dir, 'remove-guest'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => Promise.allSettled([guest.close(), host.close()]))
  await Promise.all([host.ready(), guest.ready()])
  const invite = await host.mesh.createInvite({ expiresInMs: 60_000 })
  const requests = host.mesh.watchPairingRequests()[Symbol.asyncIterator]()
  t.teardown(() => void requests.return?.())
  const joining = guest.mesh.join(invite.invite)
  const pending = await waitFor(async () => {
    const next = await requests.next()
    return (
      next.value?.requests.find(
        ({ status }: { readonly status: string }) => status === 'pending'
      ) ?? null
    )
  })
  if (!pending) throw new Error('Host did not receive a join request')
  await host.mesh.approvePairingRequest(pending.id)
  await joining
  const joinedKey = (await guest.mesh.status()).meshKey
  const guestId = (await guest.mesh.identity()).deviceId
  const joinedProfile = guest.openProfile(durableWorkProfile)
  const visible = await waitFor(async () =>
    (await host.mesh.listDevices()).some(({ id }) => id.equals(guestId))
  )
  t.ok(visible, 'joined device row replicates before removal')

  await host.mesh.removeDevice(guestId)
  const reminted = await waitFor(async () => {
    const status = await guest.mesh.status()
    return status.meshKey &&
      joinedKey &&
      !status.meshKey.equals(joinedKey) &&
      status.writable
      ? status
      : null
  })
  t.ok(reminted, 'revoked peer leaves the shared mesh and remains usable locally')
  await t.exception(
    joinedProfile.query({ type: 'list-available-work' }),
    /generation ended/i
  )
  const revoked = (await host.mesh.listDevices()).find(({ id }) => id.equals(guestId))
  t.ok(revoked?.revokedAt, 'writer revocation is replicated in the source mesh')
})

test('sync: cancelJoin aborts pairing without closing the runtime', async (t) => {
  t.timeout(60_000)
  const { dir, testnet } = await testContext(t)
  const host = createSync({
    storagePath: path.join(dir, 'join-cancel-host'),
    bootstrap: testnet.bootstrap
  })
  const guest = createSync({
    storagePath: path.join(dir, 'join-cancel-guest'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => Promise.allSettled([guest.close(), host.close()]))
  await Promise.all([host.ready(), guest.ready()])
  const before = await guest.mesh.status()
  const invite = await host.mesh.createInvite({ expiresInMs: 60_000 })
  const requests = host.mesh.watchPairingRequests()[Symbol.asyncIterator]()
  t.teardown(() => void requests.return?.())
  const joining = guest.mesh.join(invite.invite)
  const pending = await waitFor(async () => {
    const next = await requests.next()
    return (
      next.value?.requests.find(
        ({ status }: { readonly status: string }) => status === 'pending'
      ) ?? null
    )
  })
  t.ok(pending, 'join reached the real host before cancellation')

  const rejected = t.exception(joining, /cancelled/i)
  await guest.mesh.cancelJoin()
  await rejected
  const after = await guest.mesh.status()
  t.is((await guest.runtime.status()).phase, 'ready')
  t.alike(after.meshKey, before.meshKey)
  await guest.openProfile(durableWorkProfile).apply(
    {
      type: 'record-work',
      workId: 'still-open',
      payload: Buffer.from('yes'),
      payloadFormat: 'text',
      payloadVersion: 1
    },
    { operationId: 'still-open' }
  )
})

test('sync: close cancels an in-flight dynamic join and releases storage', async (t) => {
  t.timeout(60_000)
  const { dir, testnet } = await testContext(t)
  const host = createSync({
    storagePath: path.join(dir, 'join-close-host'),
    bootstrap: testnet.bootstrap
  })
  const guestPath = path.join(dir, 'join-close-guest')
  const guest = createSync({
    storagePath: guestPath,
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => host.close())
  await Promise.all([host.ready(), guest.ready()])
  const invite = await host.mesh.createInvite({ expiresInMs: 60_000 })
  const requests = host.mesh.watchPairingRequests()[Symbol.asyncIterator]()
  t.teardown(() => void requests.return?.())
  const joining = guest.mesh.join(invite.invite)
  const pending = await waitFor(async () => {
    const next = await requests.next()
    return (
      next.value?.requests.find(
        ({ status }: { readonly status: string }) => status === 'pending'
      ) ?? null
    )
  })
  t.ok(pending, 'join reached the real host before cancellation')

  const rejected = t.exception(joining, /cancelled|closing|closed/i)
  await guest.close()
  await rejected

  const reopened = createSync({
    storagePath: guestPath,
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => reopened.close())
  await reopened.ready()
  t.ok((await reopened.mesh.status()).writable, 'cancelled join released storage')
})
