import { createSocket, type DgramSocket } from 'bare-dgram'
import { networkInterfaces } from 'bare-os'
import AbortController, { type AbortSignal } from 'bare-abort-controller'
import type { Buffer } from 'bare-buffer'
import { createDisposableScope } from '@/runtime/disposable-scope'
import { registerSwarm, unregisterSwarm } from '@/runtime/runtime-lifecycle'
import { privateEndpoint, throwIfAborted } from './network'

export const DISCOVERY_GROUP = '239.255.77.76'
export const DISCOVERY_PORT = 49764
export const ANNOUNCEMENT_BYTES = 55

const RAW_DATAGRAMS_PER_SECOND = 1024
const USEFUL_ANNOUNCEMENTS_PER_SECOND = 256
const SOURCE_ANNOUNCEMENTS_PER_SECOND = 32
const MAX_ANNOUNCEMENT_SOURCES = 64

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

class LanSelectionError extends Error {}

function validIpv4(address: string) {
  const parts = address.split('.')
  return (
    parts.length === 4 &&
    parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
  )
}

export function selectLanInterfaces(
  all = networkInterfaces(),
  lanAddresses?: string[]
): LanInterface[] {
  if (
    lanAddresses &&
    (!lanAddresses.length ||
      lanAddresses.length > 8 ||
      new Set(lanAddresses).size !== lanAddresses.length ||
      lanAddresses.some((address) => !privateEndpoint(`${address}:1`)))
  ) {
    throw new LanSelectionError(
      'RPC LAN selection requires one to eight unique private IPv4 addresses'
    )
  }
  const available: LanInterface[] = []
  for (const [name, entries] of Object.entries(all).sort(([a], [b]) => a.localeCompare(b))) {
    for (const entry of entries) {
      if (entry.internal || entry.family !== 'IPv4' || !privateEndpoint(`${entry.address}:1`)) {
        continue
      }
      if (!validIpv4(entry.netmask)) continue
      const mask = ipv4(entry.netmask)
      const inverse = ~mask >>> 0
      if (!mask || inverse < 3 || (inverse & (inverse + 1)) !== 0) continue
      const address = ipv4(entry.address)
      const network = address & mask
      if (address === network >>> 0 || address === (network | ~mask) >>> 0) continue
      available.push({ name, address: entry.address, netmask: entry.netmask })
    }
  }
  function unique(entries: LanInterface[]) {
    const selected: LanInterface[] = []
    for (const entry of entries) {
      const previous = selected.find((item) => item.address === entry.address)
      if (previous && previous.netmask !== entry.netmask) {
        throw new LanSelectionError(`RPC LAN address has conflicting netmasks: ${entry.address}`)
      }
      if (!previous) selected.push(entry)
    }
    return selected
  }
  const selected = lanAddresses
    ? lanAddresses.map((address) => {
        const matching = unique(available.filter((entry) => entry.address === address))
        if (!matching.length) {
          throw new LanSelectionError(`RPC LAN address is missing or ineligible: ${address}`)
        }
        return matching[0]!
      })
    : unique(available.filter(({ name }) => LAN_NAME.test(name)))
  if (selected.length > 8) {
    throw new LanSelectionError('RPC LAN discovery supports at most eight IPv4 interfaces')
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
  lanAddresses?: string[]
  accept?(frame: Buffer, host: string): boolean
  onmessage?(frame: Buffer, host: string): void
  onstart?(): void
  onstop?(error?: Error): void
}

// This interface owns UDP only. Announcement parsing and inventory probes live in discovery.ts.
export function createLanDiscovery(
  options: LanOptions,
  deps: {
    interfaces?: (lanAddresses?: string[]) => LanInterface[]
    socket?: typeof createSocket
  } = {}
): LanDiscovery {
  const interfaces =
    deps.interfaces ?? ((addresses?: string[]) => selectLanInterfaces(undefined, addresses))
  const socketFactory = deps.socket ?? createSocket
  let scope = createDisposableScope()
  let selected: LanInterface[] = []
  let sender: DgramSocket | undefined
  let state: 'suspended' | 'opening' | 'active' | 'stopping' = 'suspended'
  let startup: AbortController | undefined
  let disposing: Promise<void> | undefined
  let terminalFailure: Error | undefined
  let closed = false
  let opening: Promise<void> | undefined
  let sending = false
  let finishSend: ((error: Error) => void) | undefined
  let stopping: Promise<void> | undefined

  function current() {
    if (options.host && options.lanAddresses && !options.lanAddresses.includes(options.host)) {
      throw new LanSelectionError('RPC LAN bind host must be included in lanAddresses')
    }
    const entries = interfaces(
      options.host && options.lanAddresses ? [options.host] : options.lanAddresses
    )
    return options.host ? entries.filter((entry) => entry.address === options.host) : entries
  }

  function checkNetwork() {
    const identity = (entries: LanInterface[]) =>
      options.lanAddresses ? entries.map(({ address, netmask }) => ({ address, netmask })) : entries
    if (JSON.stringify(identity(current())) !== JSON.stringify(identity(selected))) {
      throw new Error('RPC LAN interfaces changed; restart discovery or resume the runtime')
    }
  }

  function dispose() {
    return (disposing ??= scope[Symbol.asyncDispose]())
  }

  function suspend(error?: Error): Promise<void> {
    if (error && options.host) terminalFailure = error
    if (stopping) {
      if (error) options.onstop?.(error)
      return stopping
    }
    state = 'stopping'
    options.onstop?.(error)
    startup?.abort(undefined)
    const started = opening
    stopping = (async () => {
      try {
        await dispose()
        await started?.catch(() => {})
      } finally {
        sender = undefined
        sending = false
        state = 'suspended'
      }
    })()
    return stopping
  }

  function fail(error: Error) {
    // Keep the rejection on the shared stopping promise for lifecycle callers.
    void suspend(error).catch(() => {})
  }

  async function open(signal?: AbortSignal) {
    const activeScope = scope
    try {
      if (closed) throw new Error('RPC LAN discovery is closed')
      if (signal) throwIfAborted(signal)
      selected = current()
      if (!selected.length) {
        throw new LanSelectionError('RPC LAN discovery requires an eligible private IPv4 interface')
      }
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
          if (state === 'active' || state === 'opening') fail(error)
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
        let useful = 0
        const sources = new Map<string, number>()
        socket.on('message', (frame, remote) => {
          if (state !== 'active' || activeScope.disposed) return
          if (Date.now() - window >= 1000) {
            window = Date.now()
            packets = 0
            useful = 0
            sources.clear()
          }
          if (
            ++packets > RAW_DATAGRAMS_PER_SECOND ||
            frame.length !== ANNOUNCEMENT_BYTES ||
            remote.family !== 'IPv4'
          ) {
            return
          }
          try {
            checkNetwork()
            if (
              !isLocalSource(remote.address, selected) ||
              options.accept?.(frame, remote.address) === false
            ) {
              return
            }
            const count = sources.get(remote.address) ?? 0
            if (
              useful >= USEFUL_ANNOUNCEMENTS_PER_SECOND ||
              count >= SOURCE_ANNOUNCEMENTS_PER_SECOND ||
              (!sources.has(remote.address) && sources.size >= MAX_ANNOUNCEMENT_SOURCES)
            ) {
              return
            }
            useful++
            sources.set(remote.address, count + 1)
            options.onmessage?.(frame, remote.address)
          } catch (error) {
            fail(error as Error)
          }
        })
      }
      state = 'active'
      options.onstart?.()
      const monitor = setInterval(() => {
        try {
          checkNetwork()
        } catch (error) {
          fail(error as Error)
        }
      }, 1000)
      activeScope.defer(() => clearInterval(monitor))
    } catch (error) {
      await dispose()
      if (state === 'opening') state = 'suspended'
      throw error
    }
  }

  function start(signal?: AbortSignal): Promise<void> {
    if (opening) return opening
    if (closed) return Promise.reject(new Error('RPC LAN discovery is closed'))
    if (state === 'active') return Promise.resolve()
    if (stopping) {
      return stopping.then(() => {
        stopping = undefined
        return start(signal)
      })
    }
    scope = createDisposableScope()
    disposing = undefined
    startup = new AbortController()
    state = 'opening'
    const startupSignal = signal
      ? AbortController.AbortSignal.any([signal, startup.signal])
      : startup.signal
    opening = Promise.resolve()
      .then(() => open(startupSignal))
      .finally(() => {
        opening = undefined
        startup = undefined
      })
    return opening
  }

  const resource: LanDiscovery = {
    get suspended() {
      return state === 'suspended'
    },
    start,
    send(frame) {
      if (state !== 'active' || !sender || sending) return Promise.resolve()
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
            if (state === 'active' || state === 'opening') fail(error)
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
      if (closed || state === 'active') return
      await stopping
      if (terminalFailure) return
      try {
        if (options.host && !current().length) {
          throw new LanSelectionError(
            'RPC LAN bind address is no longer eligible; stop and restart the server'
          )
        }
        await start()
      } catch (error) {
        if (!options.host && !(error instanceof LanSelectionError)) throw error
        // Advertisement failure stays local; shared cleanup failures still reject.
        await suspend(error as Error)
      }
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
