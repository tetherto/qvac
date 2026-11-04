import test from 'brittle'
import { Buffer } from 'bare-buffer'
import EventEmitter from 'bare-events'
import { createSocket, type DgramSocket } from 'bare-dgram'
import AbortController from 'bare-abort-controller'
import {
  createLanDiscovery,
  selectLanInterfaces,
  isLocalSource,
  DISCOVERY_GROUP,
  DISCOVERY_PORT
} from '@/rpc/lan'
import {
  getRegisteredResourceCounts,
  suspendRuntime,
  resumeRuntime,
  getLifecycleState,
  assertLifecycleAllowed
} from '@/runtime/runtime-lifecycle'

const microtask = (fn: () => void) => {
  void Promise.resolve().then(fn)
}

const lan = { name: 'en0', address: '192.168.1.2', netmask: '255.255.255.0' }
class Socket extends EventEmitter {
  closed = false
  bound: [number, string] | undefined
  membership: string[][] = []
  iface = ''
  ttl = 0
  sent = 0
  bind(port: number, address: string, done: () => void) {
    this.bound = [port, address]
    microtask(done)
  }
  close(done: () => void) {
    this.closed = true
    this.emit('close')
    microtask(done)
  }
  setMulticastInterface(address: string) {
    this.iface = address
  }
  setMulticastTTL(ttl: number) {
    this.ttl = ttl
  }
  setMulticastLoopback(_enabled: boolean) {}
  addMembership(...args: string[]) {
    this.membership.push(args)
  }
  send(_frame: Buffer, port: number, group: string, done: (error: Error | null) => void) {
    if (port !== DISCOVERY_PORT || group !== DISCOVERY_GROUP) {
      throw new Error('Incorrect multicast destination')
    }
    this.sent++
    microtask(() => done(null))
  }
}
function fixture(host?: string) {
  let entries = [lan]
  const sockets: Socket[] = []
  const messages: string[] = []
  const errors: Error[] = []
  const resource = createLanDiscovery(
    {
      ...(host ? { host } : {}),
      onmessage: (_frame, address) => messages.push(address),
      onstop: (error) => {
        if (error) errors.push(error)
      }
    },
    {
      interfaces: () => entries,
      socket: (() => {
        const socket = new Socket()
        sockets.push(socket)
        return socket
      }) as unknown as typeof createSocket
    }
  )
  return {
    resource,
    sockets,
    messages,
    errors,
    change: () => {
      entries = [{ ...lan, address: '192.168.2.2' }]
    }
  }
}

test('LAN selection excludes tunnels, cellular, bridges, public addresses and invalid masks', (t) => {
  const entry = { ...lan, family: 'IPv4' as const, internal: false, mac: '', cidr: '' }
  t.alike(
    selectLanInterfaces({
      en0: [entry],
      wlan0: [{ ...entry, address: '10.0.0.2' }],
      utun0: [entry],
      tun0: [entry],
      rmnet0: [entry],
      bridge0: [entry],
      docker0: [entry],
      eth0: [{ ...entry, address: '8.8.8.8' }],
      en1: [{ ...entry, netmask: '255.0.255.0' }],
      en2: [{ ...entry, internal: true }]
    }),
    [lan, { name: 'wlan0', address: '10.0.0.2', netmask: lan.netmask }]
  )
  for (const host of ['192.168.1.3', '192.168.1.2']) t.ok(isLocalSource(host, [lan]))
  for (const host of [
    '10.0.0.2',
    '192.168.2.3',
    '192.168.1.0',
    '192.168.1.255',
    '8.8.8.8',
    'hostname'
  ]) {
    t.absent(isLocalSource(host, [lan]), host)
  }
})

test('LAN advertiser binds its exact address, pins interface and TTL, stops on network change', async (t) => {
  const f = fixture(lan.address)
  try {
    await f.resource.start()
    t.alike(f.sockets[0].bound, [0, lan.address])
    t.is(f.sockets[0].iface, lan.address)
    t.is(f.sockets[0].ttl, 1)
    await f.resource.send(Buffer.alloc(55))
    await Promise.resolve()
    t.is(f.sockets[0].sent, 1)
    f.change()
    await t.exception(f.resource.send(Buffer.alloc(55)))
    await f.resource.suspend()
    t.ok(f.resource.suspended)
    t.is(f.sockets[0].sent, 1)
    await f.resource.resume()
    t.is(f.sockets.length, 1, 'failed advertiser requires an explicit restart')
  } finally {
    await f.resource.close()
  }
  t.ok(f.sockets.every((socket) => socket.closed))
  t.is(getRegisteredResourceCounts().swarms, 0)
})

test('LAN receiver explicitly joins interfaces, filters sources, bounds traffic and rebuilds on resume', async (t) => {
  const f = fixture()
  try {
    await f.resource.start()
    const socket = f.sockets[0]
    t.alike(socket.bound, [DISCOVERY_PORT, '0.0.0.0'])
    t.alike(socket.membership, [[DISCOVERY_GROUP, lan.address]])
    const packet = (address: string, length = 55) =>
      socket.emit('message', Buffer.alloc(length), { address, family: 'IPv4' })
    packet('10.0.0.1')
    packet('192.168.1.3', 56)
    packet('192.168.1.3')
    t.alike(f.messages, ['192.168.1.3'])
    for (let i = 0; i < 1000; i++) packet('192.168.1.3')
    t.ok(f.messages.length <= 256)
    socket.emit('error', Object.assign(new Error('oversized'), { code: 'EMSGSIZE' }))
    t.absent(f.resource.suspended)
    await suspendRuntime()
    t.ok(socket.closed)
    await resumeRuntime()
    t.is(f.sockets.length, 2)
    f.change()
    f.sockets[1].emit('message', Buffer.alloc(55), { address: '192.168.1.3', family: 'IPv4' })
    await f.resource.suspend()
    t.ok(f.resource.suspended)
  } finally {
    await f.resource.close()
  }
})

test('LAN bind failures, cancellation during bind, unexpected close and missing interfaces clean sockets', async (t) => {
  for (const cancel of [false, true]) {
    const sockets: Socket[] = []
    const controller = new AbortController()
    const resource = createLanDiscovery(
      {},
      {
        interfaces: () => [lan],
        socket: (() => {
          const socket = new Socket()
          socket.bind = () => {
            microtask(() =>
              cancel ? controller.abort(undefined) : socket.emit('error', new Error('EADDRINUSE'))
            )
          }
          sockets.push(socket)
          return socket
        }) as unknown as typeof createSocket
      }
    )
    try {
      await t.exception(resource.start(controller.signal))
    } finally {
      await resource.close()
    }
    t.ok(sockets[0].closed)
  }
  const f = fixture()
  await f.resource.start()
  f.sockets[0].emit('close')
  await f.resource.close()
  t.ok(f.errors.length)
  const missing = createLanDiscovery({}, { interfaces: () => [] })
  try {
    await t.exception(missing.start())
  } finally {
    await missing.close()
  }
  t.is(getRegisteredResourceCounts().swarms, 0)
})

test('LAN send failures and stalled sends reject and release sockets, including close during send', async (t) => {
  for (const mode of ['error', 'timeout', 'close']) {
    const f = fixture(lan.address)
    await f.resource.start()
    f.sockets[0].send = (_frame, _port, _group, done) => {
      if (mode === 'error') done(new Error('EPERM'))
    }
    const sent = f.resource.send(Buffer.alloc(55))
    const rejected = t.exception(sent)
    if (mode === 'close') await f.resource.close()
    await rejected
    await f.resource.close()
    t.ok(f.sockets[0].closed)
    t.ok(f.resource.suspended)
  }
  t.is(getRegisteredResourceCounts().swarms, 0)
})

test('LAN suspension during bind awaits shared socket cleanup and rejects late activation', async (t) => {
  for (const closing of [false, true]) {
    let bound: () => void = () => {}
    let cleaned: () => void = () => {}
    const socket = new Socket()
    socket.bind = (_port, _address, done) => {
      bound = done
    }
    socket.close = (done) => {
      socket.closed = true
      cleaned = done
    }
    const resource = createLanDiscovery(
      {},
      {
        interfaces: () => [lan],
        socket: (() => socket) as unknown as typeof createSocket
      }
    )
    const opening = resource.start()
    const rejected = t.exception(opening)
    await Promise.resolve()
    t.absent(resource.suspended, 'opening resources participate in runtime suspension')
    const stopping = closing ? resource.close() : resource.suspend()
    const concurrent = closing ? resource.close() : resource.suspend()
    let stopped = false
    void stopping.then(() => {
      stopped = true
    })
    await Promise.resolve()
    t.absent(stopped, 'suspension waits for the close callback')
    bound()
    await Promise.resolve()
    t.alike(socket.membership, [], 'late bind cannot join multicast')
    cleaned()
    await Promise.all([stopping, concurrent, rejected])
    t.ok(resource.suspended)
    await resource.close()
  }
  t.is(getRegisteredResourceCounts().swarms, 0)
})

test('real Bare UDP immediate runtime suspension settles startup without a late socket', async (t) => {
  const sockets: DgramSocket[] = []
  const resource = createLanDiscovery(
    { host: '127.0.0.1' },
    {
      interfaces: () => [{ ...lan, address: '127.0.0.1' }],
      socket: ((options) => {
        const socket = typeof options === 'function' ? createSocket(options) : createSocket(options)
        sockets.push(socket)
        return socket
      }) as typeof createSocket
    }
  )
  const opening = resource.start()
  // Observe either a completed bind or cancellation before suspend wins the race.
  const started = opening.catch(() => {})
  try {
    await suspendRuntime()
    await started
    t.ok(resource.suspended)
    t.ok(sockets.every((socket) => socket.closed))
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    t.ok(resource.suspended, 'no bind continuation reactivates the resource')
    t.ok(sockets.every((socket) => socket.closed))
  } finally {
    await resource.close()
    await resumeRuntime()
  }
  t.is(getRegisteredResourceCounts().swarms, 0)
})

test('lost advertiser bind address leaves runtime active and the resource stoppable', async (t) => {
  for (const missing of [false, true]) {
    let entries = [lan]
    const socket = new Socket()
    const errors: Error[] = []
    const resource = createLanDiscovery(
      {
        host: lan.address,
        onstop(error) {
          if (error) errors.push(error)
        }
      },
      {
        interfaces: () => entries,
        socket: (() => socket) as unknown as typeof createSocket
      }
    )
    try {
      await resource.start()
      await suspendRuntime()
      entries = missing ? [] : [{ ...lan, address: '192.168.2.2' }]
      await resumeRuntime()
      t.is(getLifecycleState(), 'active')
      t.execution(() =>
        assertLifecycleAllowed({ type: 'getSystemResources' } as Parameters<
          typeof assertLifecycleAllowed
        >[0])
      )
      t.ok(resource.suspended)
      t.is(errors.length, 1)
      t.ok(socket.closed)
    } finally {
      await resource.close()
      await resumeRuntime()
    }
  }
  t.is(getRegisteredResourceCounts().swarms, 0)
})

test('LAN cleanup failures propagate through suspension and close', async (t) => {
  const socket = new Socket()
  const failure = new Error('socket cleanup failed')
  socket.close = () => {
    throw failure
  }
  const resource = createLanDiscovery(
    { host: lan.address },
    {
      interfaces: () => [lan],
      socket: (() => socket) as unknown as typeof createSocket
    }
  )
  await resource.start()
  const stopping = [resource.suspend(), resource.close()]
  await Promise.all(
    stopping.map((stopped) =>
      stopped.then(
        () => t.fail('cleanup failure must reject'),
        (error) => t.is(error, failure)
      )
    )
  )
  t.is(getRegisteredResourceCounts().swarms, 0)
})

test('LAN startup cancellation before bind settles and normal resume reports activation', async (t) => {
  const controller = new AbortController()
  controller.abort(undefined)
  const f = fixture()
  await t.exception(f.resource.start(controller.signal))
  t.ok(f.resource.suspended)
  t.is(f.sockets.length, 0)
  await f.resource.close()

  const transitions: string[] = []
  const resource = createLanDiscovery(
    {
      host: lan.address,
      onstart() {
        transitions.push('active')
      },
      onstop(error) {
        transitions.push(error ? 'failed' : 'suspended')
      }
    },
    {
      interfaces: () => [lan],
      socket: (() => new Socket()) as unknown as typeof createSocket
    }
  )
  try {
    await resource.start()
    await suspendRuntime()
    await resumeRuntime()
    t.alike(transitions, ['active', 'suspended', 'active'])
  } finally {
    await resource.close()
  }
  t.is(getRegisteredResourceCounts().swarms, 0)
})
