import {
  startRpcServer,
  rpcServerStatusStream,
  getRpcDeviceMap,
  stopRpcServer,
  discoverRpcServers,
  cancel,
  InferenceCancelledError
} from '@qvac/sdk'
import {
  BaseExecutor,
  ValidationHelpers,
  type Expectation,
  type TestResult
} from '@qvac/test-suite'
import { rpcServerTests } from '../../../../catalog/rpc-server-tests.js'

export class RpcServerExecutor extends BaseExecutor<typeof rpcServerTests> {
  pattern = /^rpc-server-/
  protected handlers = {
    'rpc-server-device-map': this.deviceMap.bind(this),
    'rpc-server-device-map-empty': this.emptyDeviceMap.bind(this),
    'rpc-server-device-map-invalid': this.invalidDeviceMap.bind(this),
    'rpc-server-lifecycle': this.lifecycle.bind(this),
    'rpc-server-empty-discovery': this.empty.bind(this),
    'rpc-server-unknown-stop': this.unknown.bind(this),
    'rpc-server-unsafe-advertisement': this.unsafe.bind(this),
    'rpc-server-cancel-discovery': this.cancelDiscovery.bind(this),
    'rpc-server-status-lifecycle': this.statusLifecycle.bind(this),
    'rpc-server-status-abort': this.statusAbort.bind(this),
    'rpc-server-status-invalid-id': this.invalidStatus.bind(this),
    'rpc-server-lan-invalid-serve': this.invalidLanServe.bind(this),
    'rpc-server-lan-invalid-lookup': this.invalidLanLookup.bind(this)
  }

  async deviceMap(_params: object, expectation: Expectation): Promise<TestResult> {
    const device = { index: 0, freeMemory: 1024, totalMemory: 2048 }
    const first = {
      url: '10.0.0.2:50052',
      rdmaAvailable: true,
      devices: [device, { ...device, index: 1 }]
    }
    const second = { url: '10.0.0.3:50052', rdmaAvailable: false, devices: [device] }
    const selected = [second, first].sort(
      (a, b) => Number(b.rdmaAvailable) - Number(a.rdmaAvailable)
    )
    const mapped = getRpcDeviceMap(selected)
    if (mapped[2]?.url !== second.url || mapped[2]?.index !== 0) {
      throw new Error('Second endpoint mapped to the wrong device')
    }
    return ValidationHelpers.validate(
      `RDMA preferred; ${mapped.map(({ alias }) => alias).join(',')}; second endpoint ${mapped[2].alias}`,
      expectation
    )
  }

  async emptyDeviceMap(_params: object, expectation: Expectation): Promise<TestResult> {
    if (getRpcDeviceMap([]).length) throw new Error('Unexpected devices')
    return ValidationHelpers.validate('no devices', expectation)
  }

  async invalidDeviceMap(_params: object, expectation: Expectation): Promise<TestResult> {
    return this.expectError(
      async () =>
        getRpcDeviceMap([
          {
            url: '10.0.0.2:50052',
            rdmaAvailable: false,
            devices: [{ index: 1, freeMemory: 1024, totalMemory: 2048 }]
          }
        ]),
      expectation
    )
  }

  async lifecycle(_params: object, expectation: Expectation): Promise<TestResult> {
    const owned = new Set<string>()
    try {
      const first = await startRpcServer()
      owned.add(first.serverId)
      const second = await startRpcServer()
      owned.add(second.serverId)
      if (first.serverId === second.serverId || first.url === second.url)
        throw new Error('Servers share an ID or endpoint')
      for (const server of [first, second]) {
        if (
          'runtime' in server ||
          typeof server.rdmaCapable !== 'boolean' ||
          !server.url.startsWith('127.0.0.1:')
        )
          throw new Error('Unexpected server transport or loopback default')
        await stopRpcServer({ serverId: server.serverId })
        owned.delete(server.serverId)
      }
      return ValidationHelpers.validate(
        'distinct IDs; transport reported; stop confirmed',
        expectation
      )
    } finally {
      await Promise.all([...owned].map((serverId) => stopRpcServer({ serverId })))
    }
  }

  async empty(_params: object, expectation: Expectation): Promise<TestResult> {
    const servers = await discoverRpcServers({
      topic: `rpc-e2e-empty-${Date.now()}-${Math.random()}`,
      timeoutMs: 100
    })
    if (servers.length) throw new Error('Unexpected candidates on unique topic')
    return ValidationHelpers.validate('no candidates', expectation)
  }

  async cancelDiscovery(_params: object, expectation: Expectation): Promise<TestResult> {
    const topic = `rpc-e2e-cancel-${Date.now()}-${Math.random()}`
    const selected = discoverRpcServers({ topic, timeoutMs: 30000 })
    const outcome = selected.then(
      () => undefined,
      (error: unknown) => error
    )
    const other = discoverRpcServers({ topic: `${topic}-other`, timeoutMs: 100 })
    try {
      if (!selected.requestId || selected.requestId === other.requestId) {
        throw new Error('Discovery calls must expose distinct cancellation IDs')
      }
      await cancel({ requestId: selected.requestId })
      if (!((await outcome) instanceof InferenceCancelledError)) {
        throw new Error('Expected typed discovery cancellation')
      }
      if ((await other).length) throw new Error('Unexpected candidates on unique topic')
      await cancel({ requestId: other.requestId })
      return ValidationHelpers.validate(
        'discovery cancelled; other discovery completed; completed cancel harmless',
        expectation
      )
    } finally {
      await Promise.all(
        [selected.requestId, other.requestId].map((requestId) => cancel({ requestId }))
      )
      await Promise.allSettled([selected, other])
    }
  }

  async statusLifecycle(_params: object, expectation: Expectation): Promise<TestResult> {
    const server = await startRpcServer()
    let stopped = false
    const controller = new AbortController()
    const updates = rpcServerStatusStream(
      { serverId: server.serverId },
      { signal: controller.signal }
    )
    try {
      const snapshot = await updates.next()
      if (
        snapshot.done ||
        snapshot.value.serverId !== server.serverId ||
        snapshot.value.url !== server.url ||
        snapshot.value.nativeState !== 'owned' ||
        snapshot.value.advertisement !== 'inactive' ||
        snapshot.value.recovery !== 'none' ||
        snapshot.value.error
      ) {
        throw new Error('Unexpected owned server status snapshot')
      }
      await stopRpcServer({ serverId: server.serverId })
      stopped = true
      const update = await updates.next()
      if (
        update.done ||
        update.value.serverId !== server.serverId ||
        update.value.nativeState !== 'stopped' ||
        update.value.advertisement !== 'inactive'
      ) {
        throw new Error('Missing stopped status update')
      }
      return ValidationHelpers.validate('owned inactive snapshot; stopped update', expectation)
    } finally {
      controller.abort()
      try {
        await updates.return(undefined)
      } finally {
        if (!stopped) await stopRpcServer({ serverId: server.serverId })
      }
    }
  }

  async statusAbort(_params: object, expectation: Expectation): Promise<TestResult> {
    const server = await startRpcServer()
    const controller = new AbortController()
    const updates = rpcServerStatusStream(
      { serverId: server.serverId },
      { signal: controller.signal }
    )
    try {
      const initial = await updates.next()
      if (initial.done || initial.value.nativeState !== 'owned')
        throw new Error('Missing owned server snapshot')
      const quiet = updates.next()
      controller.abort()
      if (!(await quiet).done) throw new Error('Aborted quiet status subscription did not end')
      const unused = rpcServerStatusStream(
        { serverId: server.serverId },
        { signal: controller.signal }
      )
      if (!(await unused.next()).done)
        throw new Error('Already aborted subscription emitted a status')
      const current = rpcServerStatusStream({ serverId: server.serverId })
      try {
        const snapshot = await current.next()
        if (
          snapshot.done ||
          snapshot.value.serverId !== server.serverId ||
          snapshot.value.nativeState !== 'owned'
        )
          throw new Error('Subscription cancellation lost native ownership')
      } finally {
        await current.return(undefined)
      }
      return ValidationHelpers.validate(
        'quiet subscription cancelled; server still owned; unused subscription closed',
        expectation
      )
    } finally {
      controller.abort()
      try {
        await updates.return(undefined)
      } finally {
        await stopRpcServer({ serverId: server.serverId })
      }
    }
  }

  async invalidStatus(_params: object, expectation: Expectation): Promise<TestResult> {
    return this.expectError(async () => {
      const controller = new AbortController()
      const updates = rpcServerStatusStream({ serverId: '' }, { signal: controller.signal })
      try {
        await updates.next()
      } finally {
        controller.abort()
        await updates.return(undefined)
      }
    }, expectation)
  }

  async invalidLanServe(_params: object, expectation: Expectation): Promise<TestResult> {
    return this.expectError(async () => {
      const server = await startRpcServer({
        lanAddresses: ['8.8.8.8'],
        allowNonLoopbackHost: true,
        discoveryTopic: 'invalid-lan-selection'
      })
      await stopRpcServer({ serverId: server.serverId })
    }, expectation)
  }

  async invalidLanLookup(_params: object, expectation: Expectation): Promise<TestResult> {
    return this.expectError(
      () =>
        discoverRpcServers({
          topic: 'invalid-lan-selection',
          lanAddresses: ['8.8.8.8'],
          timeoutMs: 100
        }),
      expectation
    )
  }

  async expectError(work: () => Promise<unknown>, expectation: Expectation): Promise<TestResult> {
    try {
      await work()
      return { passed: false, output: 'Expected an error' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        passed:
          expectation.validation === 'throws-error' && message.includes(expectation.errorContains),
        output: message
      }
    }
  }
  async unknown(_params: object, expectation: Expectation): Promise<TestResult> {
    return this.expectError(() => stopRpcServer({ serverId: 'not-owned' }), expectation)
  }
  async unsafe(_params: object, expectation: Expectation): Promise<TestResult> {
    return this.expectError(
      () => startRpcServer({ discoveryTopic: 'must-not-advertise-loopback' }),
      expectation
    )
  }
}
