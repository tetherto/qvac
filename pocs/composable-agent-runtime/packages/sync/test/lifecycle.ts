import fs from 'fs'
import path from 'path'
import test from 'brittle'
import {
  assertCompatibleRuntime,
  createSync,
  syncCompatibility
} from '../index.ts'
import { durableWorkProfile } from '../profiles/durable-work.ts'
import { testContext, waitFor } from './helpers.ts'

test('sync: createSync becomes ready offline without requiring peers', async (t) => {
  const { dir, testnet } = await testContext(t)
  const storagePath = path.join(dir, 'ready-offline')
  const sync = createSync({
    storagePath,
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => sync.close())

  await sync.ready()
  const status = await sync.runtime.status()
  t.is(status.phase, 'ready')
  t.ok(status.generation.length > 0)
  t.is(status.peerCount, 0)
  t.ok(
    status.network === 'offline' ||
      status.network === 'starting' ||
      status.network === 'online' ||
      status.network === 'degraded',
    'network is reported separately from ready'
  )
  const identity = await sync.mesh.identity()
  t.ok(identity.deviceId.byteLength > 0)
})

test('sync: suspend rejects profile mutations and resume advances generation', async (t) => {
  const { dir, testnet } = await testContext(t)
  const sync = createSync({
    storagePath: path.join(dir, 'suspend'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => sync.close())
  await sync.ready()
  const before = await sync.runtime.status()
  const profile = sync.openProfile(durableWorkProfile)

  await sync.suspend()
  t.is((await sync.runtime.status()).phase, 'suspended')
  await t.exception(
    profile.apply(
      {
        type: 'record-work',
        workId: 'suspended-work',
        payload: Buffer.from('nope'),
        payloadFormat: 'text',
        payloadVersion: 1
      },
      { operationId: 'suspended-work' }
    ),
    /suspended/i
  )

  await sync.resume()
  const after = await sync.runtime.status()
  t.is(after.phase, 'ready')
  t.ok(after.generation !== before.generation, 'resume advances generation')
})

test('sync: close releases storage locks for reopen and delete', async (t) => {
  const { dir, testnet } = await testContext(t)
  const storagePath = path.join(dir, 'close-locks')
  const first = createSync({
    storagePath,
    bootstrap: testnet.bootstrap
  })
  await first.ready()
  await first.openProfile(durableWorkProfile).apply(
    {
      type: 'record-work',
      workId: 'persistent-work',
      payload: Buffer.from('persistent'),
      payloadFormat: 'text',
      payloadVersion: 1
    },
    { operationId: 'persistent-work' }
  )
  await first.close()

  const second = createSync({
    storagePath,
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => second.close())
  await second.ready()
  t.ok(
    (await second.openProfile(durableWorkProfile).query({
      type: 'get-work',
      workId: 'persistent-work'
    })) != null
  )
  await second.close()

  fs.rmSync(storagePath, { recursive: true, force: true })
  t.absent(fs.existsSync(storagePath), 'closed storage can be removed completely')
})

test('sync: close during ready tears down late Core and Client', async (t) => {
  const { dir, testnet } = await testContext(t)
  const storagePath = path.join(dir, 'close-during-ready')
  const sync = createSync({
    storagePath,
    bootstrap: testnet.bootstrap
  })

  const opening = sync.ready()
  const started = await waitFor(
    () =>
      fs.existsSync(path.join(storagePath, 'local')) ||
      fs.existsSync(path.join(storagePath, 'corestore'))
  )
  t.ok(started, 'open created real storage before close raced it')

  await sync.close()
  const opened = await Promise.allSettled([opening])
  t.ok(
    opened[0].status === 'fulfilled' || opened[0].status === 'rejected',
    'in-flight ready settles'
  )

  await t.exception(
    Promise.resolve().then(() => sync.openProfile(durableWorkProfile)),
    /closed/i
  )
  await t.exception(sync.ready(), /closed/i)

  const again = createSync({
    storagePath,
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => again.close())
  const reopened = await Promise.allSettled([again.ready()])
  t.is(reopened[0].status, 'fulfilled', 'close released storage locks for a later open')
  await again.close()

  fs.rmSync(storagePath, { recursive: true, force: true })
  t.absent(fs.existsSync(storagePath), 'closed storage can be removed completely')
})

test('sync: concurrent suspend and resume coalesce to one transition', async (t) => {
  const { dir, testnet } = await testContext(t)
  const sync = createSync({
    storagePath: path.join(dir, 'coalesce'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => sync.close())
  await sync.ready()
  const before = await sync.runtime.status()

  // Start resumes while suspend is still in flight so callers share one transition.
  const suspending = sync.suspend()
  const resuming = Promise.all([sync.resume(), sync.resume(), sync.resume()])
  await Promise.all([suspending, resuming])

  const after = await sync.runtime.status()
  t.is(after.phase, 'ready')
  t.is(
    after.generation,
    String(Number(before.generation) + 1),
    'resume advances generation exactly once'
  )

  const suspendedGeneration = after.generation
  const resumingAgain = sync.resume()
  const suspendingAgain = Promise.all([sync.suspend(), sync.suspend(), sync.suspend()])
  await Promise.all([resumingAgain, suspendingAgain])
  const finalStatus = await sync.runtime.status()
  t.is(finalStatus.phase, 'suspended')
  t.is(
    finalStatus.generation,
    suspendedGeneration,
    'concurrent suspend after resume does not advance generation'
  )
})

test('sync: suspend awaits Hyperswarm discovery teardown', async (t) => {
  const { dir, testnet } = await testContext(t)
  const sync = createSync({
    storagePath: path.join(dir, 'discovery-teardown'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => sync.close())
  await sync.ready()

  const joined = await waitFor(async () => {
    const diagnostics = await sync.runtime.diagnostics()
    const network = diagnostics.children.find(
      (child) => child.name === 'replicated-mesh-network'
    )
    return network?.info?.topicPresent === true ? network : null
  })
  t.ok(joined, 'joined discovery topic is present before suspend')

  await sync.suspend()
  const after = await sync.runtime.diagnostics()
  const networkAfter = after.children.find(
    (child) => child.name === 'replicated-mesh-network'
  )
  t.is(networkAfter?.info?.discoveryTeardownComplete, true)
  t.is(
    networkAfter?.info?.topicPresent,
    false,
    'suspend completion means awaited Hyperswarm discovery destroy/unannounce finished'
  )
  t.is((await sync.runtime.status()).network, 'stopped')
})

test('sync: accepted profile mutations persist across suspend without extra flush', async (t) => {
  const { dir, testnet } = await testContext(t)
  const sync = createSync({
    storagePath: path.join(dir, 'local-flush'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => sync.close())
  await sync.ready()

  await sync.openProfile(durableWorkProfile).apply(
    {
      type: 'record-work',
      workId: 'flushed-work',
      payload: Buffer.from('flushed'),
      payloadFormat: 'text',
      payloadVersion: 1
    },
    { operationId: 'flushed-work' }
  )
  await sync.suspend()
  await sync.resume()
  t.ok(
    (await sync.openProfile(durableWorkProfile).query({
      type: 'get-work',
      workId: 'flushed-work'
    })) != null
  )
})

test('sync: runtime diagnostics expose Supervisor children', async (t) => {
  const { dir, testnet } = await testContext(t)
  const sync = createSync({
    storagePath: path.join(dir, 'diagnostics'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => sync.close())
  await sync.ready()

  const diagnostics = await sync.runtime.diagnostics()
  t.alike(
    diagnostics.children.map(({ name, state, deps }) => ({ name, state, deps })),
    [
      { name: 'local-metadata-store', state: 'running', deps: [] },
      { name: 'identity-corestore', state: 'running', deps: [] },
      {
        name: 'replicated-mesh-network',
        state: 'running',
        deps: ['local-metadata-store', 'identity-corestore']
      }
    ]
  )
})

test('sync: compatibility rail requires the profile protocol', async (t) => {
  await t.exception(
    Promise.resolve().then(() =>
      assertCompatibleRuntime(syncCompatibility, {
        ...syncCompatibility,
        capabilities: ['local-profile']
      })
    ),
    /profile-protocol/i
  )
})
