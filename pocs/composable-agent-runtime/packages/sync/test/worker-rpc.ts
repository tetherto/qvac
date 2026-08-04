import path from 'path'
import test from 'brittle'
import { SyncClient } from '../lib/client.ts'
import { SyncCore } from '../lib/core.ts'
import { duplexPair } from '../lib/transport/duplex-pair.ts'
import { testContext } from './helpers.ts'

test('sync: lifecycle and diagnostics cross the worker RPC boundary', async (t) => {
  const { dir, testnet } = await testContext(t)
  const core = new SyncCore({
    storagePath: path.join(dir, 'worker-rpc'),
    bootstrap: testnet.bootstrap
  })
  await core.ready()
  t.teardown(() => core.close())
  const [server, clientStream] = duplexPair()
  core.connect(server)
  const client = new SyncClient(clientStream)
  await client.ready()
  t.teardown(() => client.close())

  t.is((await client.runtimeStatus()).phase, 'ready')
  t.ok((await client.runtimeDiagnostics()).children.length > 0)
  const mesh = await client.meshStatus()
  t.is(mesh.state, 'joined')
  t.ok(mesh.meshKey?.byteLength === 32)
  const identity = await client.getIdentity()
  t.alike((await client.listDevices()).devices.map(({ id }) => id), [identity.deviceId])
  await client.renameDevice({ name: 'worker-device' })
  t.is((await client.listDevices()).devices[0]?.name, 'worker-device')
  await client.suspend()
  t.is((await client.runtimeStatus()).phase, 'suspended')
  await client.resume()
  t.is((await client.runtimeStatus()).phase, 'ready')
  const beforeLeave = (await client.meshStatus()).meshKey
  await client.leaveMesh()
  const afterLeave = (await client.meshStatus()).meshKey
  t.ok(
    beforeLeave && afterLeave && !beforeLeave.equals(afterLeave),
    'leave crosses RPC and remints the mesh'
  )
})
