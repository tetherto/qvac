// Run separately on a multicast-capable Wi-Fi or Ethernet link with npm run test:rpc:lan.
import test from 'brittle'
import { Buffer } from 'bare-buffer'
import { spawn } from 'bare-subprocess'
import path from 'bare-path'
import os from 'bare-os'
import { selectLanInterfaces } from '@/rpc/lan'
import { createRpcServerManager } from '@/rpc/manager'
import { waitForReady } from '@/rpc/network'
import { advertiseRpcServer, discoverRpcEndpoints } from '@/rpc/discovery'
import { ggmlRpcServerProvider } from '@/rpc/ggml-provider'
import { createRequestRegistry } from '@/runtime/request-context'
import { createDisposableScope } from '@/runtime/disposable-scope'
import {
  getRegisteredResourceCounts,
  suspendRuntime,
  resumeRuntime
} from '@/runtime/runtime-lifecycle'

const host = selectLanInterfaces()[0]?.address
if (!host) throw new Error('This integration test requires a private IPv4 Wi-Fi or Ethernet link')

test('real LAN multicast finds multiple native servers from concurrent lookups and validates inventories', async (t) => {
  await using scope = createDisposableScope()
  const registry = createRequestRegistry()
  const topic = `lan-integration-${Date.now()}`
  const urls: string[] = []
  const withdrawals: Array<() => Promise<void>> = []
  for (let i = 0; i < 2; i++) {
    const server = await ggmlRpcServerProvider.start({ host, allowNonLoopbackHost: true })
    scope.defer(() => server.stop())
    const withdraw = await advertiseRpcServer(topic, server.url)
    scope.defer(withdraw)
    withdrawals.push(withdraw)
    urls.push(server.url)
  }
  async function lookup(suffix: string, budget = 2200) {
    await using ctx = await registry.begin({
      requestId: `${suffix}-${Date.now()}`,
      kind: 'rpcDiscovery'
    })
    return discoverRpcEndpoints(suffix === 'other' ? `${topic}-other` : topic, budget, ctx)
  }
  const [first, second, other] = await Promise.all([
    lookup('first'),
    lookup('second'),
    lookup('other')
  ])
  for (const result of [first, second]) {
    t.alike(result.map(({ url }) => url).sort(), [...urls].sort())
    t.ok(
      result.every(({ devices }) => devices.length > 0),
      'native TCP inventory returned devices'
    )
  }
  t.alike(other, [])
  function childLookup() {
    const child = spawn(Bare.argv[0]!, [
      path.resolve(os.cwd(), 'test/dist/test/fixtures/rpc-lan-child.js'),
      topic
    ])
    let output = ''
    child.stdout!.on('data', (chunk) => {
      if (Buffer.isBuffer(chunk)) output += chunk.toString()
    })
    const exited = new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Lookup child exited ${code}`))
      )
    })
    scope.defer(async () => {
      if (child.exitCode === null) child.kill()
      await exited.catch(() => {})
    })
    return exited.then(() => JSON.parse(output.trim()) as string[])
  }
  const processes = await Promise.all([childLookup(), childLookup()])
  for (const result of processes) {
    t.alike(result, [...urls].sort(), 'separate processes share the discovery port')
  }
  await suspendRuntime()
  await resumeRuntime()
  t.is((await lookup('resumed')).length, 2)
  const expiring = lookup('expiring', 4300)
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  await Promise.all(withdrawals.map((withdraw) => withdraw()))
  t.alike(await expiring, [], 'withdrawn servers expire even during an existing lookup')
  t.is(getRegisteredResourceCounts().swarms, 0)
})

test('native RPC manager selects the sole LAN address and advertises the resulting endpoint', async (t) => {
  const interfaces = selectLanInterfaces()
  const manager = createRpcServerManager({
    start: (options) => ggmlRpcServerProvider.start(options),
    ready: (server, ctx) => waitForReady(server.host, server.port, ctx.signal),
    advertise: advertiseRpcServer
  })
  const registry = createRequestRegistry()
  await using ctx = await registry.begin({ requestId: 'auto-bind', kind: 'rpcServer' })
  const topic = `auto-bind-${Date.now()}`
  try {
    if (interfaces.length > 1) {
      await t.exception(
        manager.start({ allowNonLoopbackHost: true, discoveryTopic: topic }, ctx),
        /Multiple eligible RPC LAN addresses/
      )
      t.is(manager.size, 0)
    } else {
      const server = await manager.start({ allowNonLoopbackHost: true, discoveryTopic: topic }, ctx)
      t.ok(server.url.startsWith(`${interfaces[0]!.address}:`))
      const found = await discoverRpcEndpoints(topic, 2200, ctx)
      t.alike(
        found.map(({ url }) => url),
        [server.url]
      )
      t.ok(found[0]?.devices.length)
    }
  } finally {
    await manager.close()
  }
  t.is(manager.size, 0)
  t.is(getRegisteredResourceCounts().swarms, 0)
})
