import type { RequestContext } from '@/runtime/request-context'
import { generateRandomRequestId } from '@/runtime/request-id'
import { createDisposableScope } from '@/runtime/disposable-scope'
import { RpcServerOperationError } from '@/errors/index'
import { createErrorResponse } from '@/schemas/error'
import type {
  StartRpcServerOptions,
  RpcServerInfo,
  RpcServerHandle,
  RpcServerStatus
} from '@/schemas/rpc-server'
import { privateEndpoint, throwIfAborted } from './network'
import { selectLanInterfaces } from './lan'

export type ManagedRpcServer = RpcServerHandle
export interface RpcServerDependencies {
  start(options: StartRpcServerOptions): Promise<ManagedRpcServer>
  ready(server: ManagedRpcServer, ctx: RequestContext): Promise<void>
  advertise(
    topic: string,
    url: string,
    ctx: RequestContext,
    onstatus?: (state: 'advertising' | 'suspended' | 'failed', error?: Error) => void,
    lanAddresses?: string[]
  ): Promise<() => Promise<void>>
  lanInterfaces?: typeof selectLanInterfaces
}
interface OwnedServer {
  handle: ManagedRpcServer
  active: boolean
  status: RpcServerStatus
  withdraw?: () => Promise<void>
  stopping?: Promise<void>
}

export function createRpcServerManager(deps: RpcServerDependencies) {
  const servers = new Map<string, OwnedServer>()
  const listeners = new Set<(status: RpcServerStatus) => void>()
  function publish(entry: OwnedServer, status: Partial<RpcServerStatus>) {
    entry.status = { ...entry.status, error: undefined, ...status }
    for (const listener of listeners) listener(entry.status)
  }
  const starts = new Set<Promise<RpcServerInfo>>()
  let closing: Promise<void> | undefined

  async function stop(serverId: string): Promise<void> {
    const entry = servers.get(serverId)
    if (!entry) throw new Error(`Unknown RPC server: ${serverId}`)
    if (entry.stopping) return entry.stopping
    entry.stopping = (async () => {
      const errors: unknown[] = []
      if (entry.withdraw) {
        try {
          await entry.withdraw()
          delete entry.withdraw
        } catch (error) {
          errors.push(error)
        }
      }
      try {
        await entry.handle.stop()
      } catch (error) {
        errors.push(error)
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          `Failed to stop RPC server ${serverId}: ${errors.map(String).join('; ')}`,
          { cause: errors[0] }
        )
      }
      publish(entry, {
        nativeState: 'stopped',
        advertisement: 'inactive',
        reason: 'Native server stopped',
        recovery: 'none'
      })
      servers.delete(serverId)
    })()
    try {
      await entry.stopping
    } finally {
      delete entry.stopping
    }
  }

  async function startOwned(
    options: StartRpcServerOptions,
    ctx: RequestContext
  ): Promise<RpcServerInfo> {
    throwIfAborted(ctx.signal)
    if (options.lanAddresses && !options.discoveryTopic) {
      throw new Error('lanAddresses requires discoveryTopic when starting an RPC server')
    }
    if (
      options.discoveryTopic &&
      (!options.allowNonLoopbackHost ||
        (options.host !== undefined && !privateEndpoint(`${options.host}:1`)))
    ) {
      throw new Error(
        'RPC advertising requires allowNonLoopbackHost: true; an explicit host must be a private IPv4 address'
      )
    }
    if (
      options.discoveryTopic &&
      (options.host === undefined || options.lanAddresses !== undefined)
    ) {
      const interfaces = (deps.lanInterfaces ?? selectLanInterfaces)(
        undefined,
        options.lanAddresses
      )
      if (!interfaces.length) {
        throw new Error(
          'RPC advertising requires an eligible private IPv4 Wi-Fi or Ethernet address'
        )
      }
      if (
        options.host !== undefined &&
        !interfaces.some((entry) => entry.address === options.host)
      ) {
        throw new Error('RPC bind host must belong to lanAddresses')
      }
      if (options.host === undefined && interfaces.length > 1) {
        throw new Error(
          `Multiple eligible RPC LAN addresses; specify host explicitly: ${interfaces.map(({ name, address }) => `${name}=${address}`).join(', ')}`
        )
      }
      options = { ...options, host: options.host ?? interfaces[0]!.address }
    }
    await using scope = createDisposableScope()
    const handle = await deps.start(options)
    const serverId = generateRandomRequestId()
    const entry: OwnedServer = {
      handle,
      active: false,
      status: {
        serverId,
        url: handle.url,
        nativeState: 'owned',
        advertisement: options.discoveryTopic ? 'starting' : 'inactive',
        reason: options.discoveryTopic
          ? 'Starting LAN advertisement'
          : 'Advertising was not requested',
        recovery: 'none'
      }
    }
    servers.set(serverId, entry)
    publish(entry, {})
    let transferred = false
    scope.defer(async () => {
      if (!transferred) await stop(serverId)
    })
    throwIfAborted(ctx.signal)
    await deps.ready(handle, ctx)
    throwIfAborted(ctx.signal)
    if (closing) throw new Error('RPC server manager is closing')
    if (options.discoveryTopic) {
      try {
        entry.withdraw = await deps.advertise(
          options.discoveryTopic,
          handle.url,
          ctx,
          (advertisement, error) => {
            if (entry.status.advertisement === 'failed' && advertisement === 'suspended') return
            publish(entry, {
              advertisement,
              reason: error
                ? error.message
                : advertisement === 'suspended'
                  ? 'Runtime suspended LAN advertising'
                  : 'LAN advertising is active',
              recovery:
                advertisement === 'failed'
                  ? 'restart'
                  : advertisement === 'suspended'
                    ? 'resume'
                    : 'none',
              ...(error && {
                error: createErrorResponse(
                  new RpcServerOperationError('advertiseRpcServer', error.message, error)
                )
              })
            })
          },
          options.lanAddresses
        )
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error))
        publish(entry, {
          advertisement: 'failed',
          reason: cause.message,
          recovery: 'restart',
          error: createErrorResponse(
            new RpcServerOperationError('advertiseRpcServer', cause.message, cause)
          )
        })
        throw error
      }
    }
    throwIfAborted(ctx.signal)
    if (closing) throw new Error('RPC server manager is closing')
    entry.active = true
    transferred = true
    return { serverId, url: handle.url, rdmaCapable: handle.rdmaCapable }
  }

  function start(options: StartRpcServerOptions, ctx: RequestContext): Promise<RpcServerInfo> {
    if (closing) return Promise.reject(new Error('RPC server manager is closing'))
    const task = startOwned(options, ctx)
    starts.add(task)
    void task.then(
      () => starts.delete(task),
      () => starts.delete(task)
    )
    return task
  }

  function close(): Promise<void> {
    if (closing) return closing
    closing = (async () => {
      // Start every known stop before waiting for starts that may be rolling back.
      const initialIds = new Set([...servers].filter(([, entry]) => entry.active).map(([id]) => id))
      const stopping = Promise.allSettled([...initialIds].map(stop))
      await Promise.allSettled([...starts])
      const lateStops = Promise.allSettled(
        [...servers.keys()].filter((id) => !initialIds.has(id)).map(stop)
      )
      const results = [...(await stopping), ...(await lateStops)]
      const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
      if (errors.length) throw new AggregateError(errors, 'Failed to stop owned RPC servers')
    })()
    return closing.finally(() => {
      closing = undefined
    })
  }

  return {
    start,
    stop,
    close,
    subscribe(listener: (status: RpcServerStatus) => void) {
      listeners.add(listener)
      for (const entry of servers.values()) listener(entry.status)
      return () => {
        listeners.delete(listener)
      }
    },
    get size() {
      return servers.size
    }
  }
}
