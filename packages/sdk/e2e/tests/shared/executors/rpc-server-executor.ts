import {
  startRpcServer,
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
import { rpcServerTests } from '../../rpc-server-tests.js'

export class RpcServerExecutor extends BaseExecutor<typeof rpcServerTests> {
  pattern = /^rpc-server-/
  protected handlers = {
    'rpc-server-lifecycle': this.lifecycle.bind(this),
    'rpc-server-empty-discovery': this.empty.bind(this),
    'rpc-server-unknown-stop': this.unknown.bind(this),
    'rpc-server-unsafe-advertisement': this.unsafe.bind(this),
    'rpc-server-cancel-discovery': this.cancelDiscovery.bind(this)
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
          server.runtime !== 'in-process' ||
          server.rdmaCapable !== false ||
          !server.url.startsWith('127.0.0.1:')
        )
          throw new Error('Unexpected server transport or loopback default')
        await stopRpcServer({ serverId: server.serverId })
        owned.delete(server.serverId)
      }
      return ValidationHelpers.validate('distinct IDs; TCP only; stop confirmed', expectation)
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
