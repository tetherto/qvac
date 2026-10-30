import { createSocket, type DgramSocket } from 'bare-dgram'
import { networkInterfaces } from 'bare-os'
import type { AbortSignal } from 'bare-abort-controller'
import type { Buffer } from 'bare-buffer'
import { createDisposableScope } from '@/runtime/disposable-scope'
import { registerSwarm, unregisterSwarm } from '@/runtime/runtime-lifecycle'
import { privateEndpoint, throwIfAborted } from './network'

export const DISCOVERY_GROUP = '239.255.77.76'
export const DISCOVERY_PORT = 49764
export const ANNOUNCEMENT_BYTES = 55

export interface LanInterface {
  name: string
  address: string
  netmask: string
}

// Fail closed for tunnels, cellular links, bridges and unknown interface names.
const LAN_NAME =
  /^(?:en\d+|eth\d+|wlan\d+|(?:en|wl)[opsx][a-zA-Z0-9]+|Ethernet(?: \d+)?|Wi-Fi(?: \d+)?)$/

function ipv4(address: string): number {
  return address.split('.').reduce((n, part) => (n << 8) | Number(part), 0) >>> 0
}

export function selectLanInterfaces(all = networkInterfaces()): LanInterface[] {
  const selected: LanInterface[] = []
  for (const [name, entries] of Object.entries(all).sort(([a], [b]) => a.localeCompare(b))) {
    if (!LAN_NAME.test(name)) continue
    for (const entry of entries) {
      if (entry.internal || entry.family !== 'IPv4' || !privateEndpoint(`${entry.address}:1`)) {
        continue
      }
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(entry.netmask)) continue
      const mask = ipv4(entry.netmask)
      const inverse = ~mask >>> 0
      if (!mask || inverse < 3 || (inverse & (inverse + 1)) !== 0) continue
      if (selected.some((item) => item.address === entry.address)) continue
      selected.push({ name, address: entry.address, netmask: entry.netmask })
    }
  }
  if (selected.length > 8) {
    throw new Error('RPC LAN discovery supports at most eight IPv4 interfaces')
  }
  return selected
}

export function isLocalSource(host: string, interfaces: LanInterface[]): boolean {
  if (!privateEndpoint(`${host}:1`)) return false
  const address = ipv4(host)
  return interfaces.some((entry) => {
    const mask = ipv4(entry.netmask)
    const network = ipv4(entry.address) & mask
    return (
      (address & mask) === network &&
      address !== network >>> 0 &&
      address !== (network | ~mask) >>> 0
    )
  })
}

export interface LanDiscovery {
  readonly suspended: boolean
  start(signal?: AbortSignal): Promise<void>
  send(frame: Buffer): Promise<void>
  suspend(): Promise<void>
  resume(): Promise<void>
  close(): Promise<void>
}

interface LanOptions {
  host?: string
  onmessage?(frame: Buffer, host: string): void
  onstop?(error?: Error): void
}

// This interface owns UDP only. Announcement parsing and inventory probes live in discovery.ts.
export function createLanDiscovery(
  options: LanOptions,
  deps: { interfaces?: () => LanInterface[]; socket?: typeof createSocket } = {}
): LanDiscovery {
  const interfaces = deps.interfaces ?? selectLanInterfaces
  const socketFactory = deps.socket ?? createSocket
  let scope = createDisposableScope()
  let selected: LanInterface[] = []
  let sender: DgramSocket | undefined
  let suspended = true
  let closed = false
  let opening: Promise<void> | undefined
  let sending = false
  let finishSend: ((error: Error) => void) | undefined
  let stopping: Promise<void> | undefined

  function current() {
    const entries = interfaces()
    return options.host ? entries.filter((entry) => entry.address === options.host) : entries
  }

  function checkNetwork() {
    if (JSON.stringify(current()) !== JSON.stringify(selected)) {
      throw new Error('RPC LAN interfaces changed; restart discovery or resume the runtime')
    }
  }

  function suspend(error?: Error): Promise<void> {
    if (stopping) return stopping
    suspended = true
    options.onstop?.(error)
    stopping = scope[Symbol.asyncDispose]().finally(() => {
      sender = undefined
      sending = false
      stopping = undefined
    })
    return stopping
  }

  function fail(error: Error) {
    void suspend(error)
  }

  async function open(signal?: AbortSignal) {
    if (closed) throw new Error('RPC LAN discovery is closed')
    if (signal) throwIfAborted(signal)
    selected = current()
    if (!selected.length) {
      throw new Error('RPC LAN discovery requires a private IPv4 Wi-Fi or Ethernet interface')
    }
    scope = createDisposableScope()
    const activeScope = scope
    try {
      const socket = socketFactory({
        type: 'udp4',
        reuseAddr: !options.host,
        readBufferSize: ANNOUNCEMENT_BYTES + 1,
        recvBufferSize: 65536,
        sendBufferSize: 8192
      })
      activeScope.defer(() => new Promise<void>((resolve) => socket.close(resolve)))
      activeScope.defer(() => finishSend?.(new Error('RPC LAN discovery socket closed')))
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('RPC LAN discovery bind timed out')), 1000)
        const abort = () => {
          try {
            if (signal) throwIfAborted(signal)
          } catch (error) {
            reject(error)
          }
        }
        const onError = (error: Error) => {
          // Truncation is hostile traffic, not a transport failure.
          if ('code' in error && error.code === 'EMSGSIZE') return
          reject(error)
          fail(error)
        }
        const onClose = () => {
          const error = new Error('RPC LAN discovery socket closed')
          reject(error)
          if (!suspended) fail(error)
        }
        socket.on('error', onError)
        socket.once('close', onClose)
        activeScope.defer(() => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
        })
        signal?.addEventListener('abort', abort, { once: true })
        socket.bind(options.host ? 0 : DISCOVERY_PORT, options.host ?? '0.0.0.0', () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          resolve()
        })
      })
      if (activeScope.disposed || closed) throw new Error('RPC LAN discovery closed during startup')
      if (signal) throwIfAborted(signal)
      checkNetwork()
      if (options.host) {
        socket.setMulticastInterface(options.host)
        socket.setMulticastTTL(1)
        socket.setMulticastLoopback(true)
        sender = socket
      } else {
        for (const entry of selected) socket.addMembership(DISCOVERY_GROUP, entry.address)
        let window = Date.now()
        let packets = 0
        socket.on('message', (frame, remote) => {
          if (suspended || activeScope.disposed) return
          if (Date.now() - window >= 1000) {
            window = Date.now()
            packets = 0
          }
          if (++packets > 256 || frame.length !== ANNOUNCEMENT_BYTES || remote.family !== 'IPv4') {
            return
          }
          try {
            checkNetwork()
            if (isLocalSource(remote.address, selected)) options.onmessage?.(frame, remote.address)
          } catch (error) {
            fail(error as Error)
          }
        })
      }
      suspended = false
      const monitor = setInterval(() => {
        try {
          checkNetwork()
        } catch (error) {
          fail(error as Error)
        }
      }, 1000)
      activeScope.defer(() => clearInterval(monitor))
    } catch (error) {
      await suspend()
      throw error
    }
  }

  function start(signal?: AbortSignal) {
    if (opening) return opening
    if (!suspended && !closed) return Promise.resolve()
    opening = open(signal).finally(() => {
      opening = undefined
    })
    return opening
  }

  const resource: LanDiscovery = {
    get suspended() {
      return suspended
    },
    start,
    send(frame) {
      if (suspended || !sender || sending) return Promise.resolve()
      const socket = sender
      return new Promise<void>((resolve, reject) => {
        let finished = false
        const timer = setTimeout(
          () => finish(new Error('RPC LAN announcement send timed out')),
          1000
        )
        function finish(error?: Error | null) {
          if (finished) return
          finished = true
          clearTimeout(timer)
          sending = false
          finishSend = undefined
          if (error) {
            if (!suspended) fail(error)
            reject(error)
          } else resolve()
        }
        finishSend = finish
        try {
          checkNetwork()
          sending = true
          socket.send(frame, DISCOVERY_PORT, DISCOVERY_GROUP, finish)
        } catch (error) {
          finish(error as Error)
        }
      })
    },
    suspend,
    async resume() {
      if (closed || !suspended) return
      await opening
      await stopping
      await scope[Symbol.asyncDispose]()
      await start()
    },
    async close() {
      closed = true
      try {
        await suspend()
      } finally {
        unregisterSwarm(resource)
      }
    }
  }
  registerSwarm(resource, { label: 'rpc-lan-discovery', createdAt: Date.now() })
  return resource
}
