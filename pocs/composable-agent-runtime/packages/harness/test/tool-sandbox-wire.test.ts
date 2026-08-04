import { expect, test } from 'bun:test'
import * as Harness from './internal-tool-sandbox.ts'
import ToolSandboxRPC from '../spec/tool-sandbox/hrpc/index.js'
import { parseToolSandboxDescription } from '../lib/tool-sandbox/wire.ts'
import type {
  ToolSandboxExecutionRequest
} from './internal-tool-sandbox.ts'
import type { HarnessJsonValue } from '../lib/types.ts'

test('tool sandbox HRPC describes and returns structured generation-matched results', async () => {
  const duplexPair = Reflect.get(Harness, 'duplexPair')
  const serve = Reflect.get(Harness, 'serveToolSandbox')
  const connect = Reflect.get(Harness, 'connectToolSandbox')
  expect(typeof serve).toBe('function')
  expect(typeof connect).toBe('function')
  if (
    typeof duplexPair !== 'function' ||
    typeof serve !== 'function' ||
    typeof connect !== 'function'
  ) {
    return
  }

  const [server, clientStream] = duplexPair()
  serve(server, {
    generation: 4,
    processId: 404,
    executor: {
      async invoke(
        input: ToolSandboxExecutionRequest
      ): Promise<HarnessJsonValue> {
        if (input.toolName === 'fail') throw new Error('fixture failed')
        return input.input
      }
    }
  })
  const client = connect(clientStream)

  await expect(client.ready()).resolves.toEqual({
    component: 'tool-sandbox',
    runtime: 'bare',
    generation: 4,
    processId: 404,
    protocolVersion: 1
  })
  await expect(
    client.invoke({
      invocationId: 'ok',
      generation: 4,
      toolName: 'echo',
      input: { value: 'hello' }
    })
  ).resolves.toEqual({
    status: 'success',
    invocationId: 'ok',
    generation: 4,
    value: { value: 'hello' }
  })
  await expect(
    client.invoke({
      invocationId: 'error',
      generation: 4,
      toolName: 'fail',
      input: {}
    })
  ).resolves.toEqual({
    status: 'error',
    invocationId: 'error',
    generation: 4,
    error: {
      code: 'TOOL_EXECUTION_FAILED',
      message: 'fixture failed'
    }
  })
  await client.close()
})

test('tool sandbox HRPC rejects generation mismatch without executing', async () => {
  const duplexPair = Reflect.get(Harness, 'duplexPair')
  const serve = Reflect.get(Harness, 'serveToolSandbox')
  const connect = Reflect.get(Harness, 'connectToolSandbox')
  expect(typeof serve).toBe('function')
  expect(typeof connect).toBe('function')
  if (
    typeof duplexPair !== 'function' ||
    typeof serve !== 'function' ||
    typeof connect !== 'function'
  ) {
    return
  }

  let executed = false
  const [server, clientStream] = duplexPair()
  serve(server, {
    generation: 2,
    processId: 202,
    executor: {
      async invoke() {
        executed = true
        return null
      }
    }
  })
  const client = connect(clientStream)
  const result = await client.invoke({
    invocationId: 'stale',
    generation: 1,
    toolName: 'echo',
    input: {}
  })

  expect(result).toEqual({
    status: 'error',
    invocationId: 'stale',
    generation: 2,
    error: {
      code: 'GENERATION_MISMATCH',
      message: 'sandbox generation mismatch'
    }
  })
  expect(executed).toBe(false)
  await client.close()
})

test('tool sandbox HRPC cancellation aborts only the matching invocation', async () => {
  const duplexPair = Reflect.get(Harness, 'duplexPair')
  const serve = Reflect.get(Harness, 'serveToolSandbox')
  const connect = Reflect.get(Harness, 'connectToolSandbox')
  expect(typeof serve).toBe('function')
  expect(typeof connect).toBe('function')
  if (
    typeof duplexPair !== 'function' ||
    typeof serve !== 'function' ||
    typeof connect !== 'function'
  ) {
    return
  }

  const started = deferred<void>()
  const [server, clientStream] = duplexPair()
  serve(server, {
    generation: 8,
    processId: 808,
    executor: {
      async invoke(
        input: ToolSandboxExecutionRequest
      ): Promise<HarnessJsonValue> {
        started.resolve()
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        throw new Error('aborted by fixture')
      }
    }
  })
  const client = connect(clientStream)
  const invocation = client.invoke({
    invocationId: 'cancel-me',
    generation: 8,
    toolName: 'wait',
    input: {}
  })
  await started.promise
  await client.cancel({ invocationId: 'not-me', generation: 8 })
  await client.cancel({ invocationId: 'cancel-me', generation: 8 })

  await expect(invocation).resolves.toEqual({
    status: 'error',
    invocationId: 'cancel-me',
    generation: 8,
    error: {
      code: 'TOOL_CANCELLED',
      message: 'tool invocation cancelled'
    }
  })
  await client.close()
})

test('tool sandbox configures secrets over HRPC without reflecting them', async () => {
  const [server, clientStream] = Harness.duplexPair()
  let configuredToken = ''
  Harness.serveToolSandbox(server, {
    generation: 9,
    processId: 909,
    configure(configuration) {
      configuredToken =
        typeof configuration.weather === 'object' &&
        configuration.weather !== null &&
        !Array.isArray(configuration.weather) &&
        typeof configuration.weather.token === 'string'
          ? configuration.weather.token
          : ''
      return {
        async invoke() {
          return { configured: configuredToken.length > 0 }
        }
      }
    }
  })
  const client = Harness.connectToolSandbox(clientStream)

  const configured = await client.configure({
    generation: 9,
    configuration: {
      weather: {
        port: 43123,
        token: 'secret-loopback-token'
      }
    }
  })
  expect(configured).toEqual({ generation: 9 })
  expect(JSON.stringify(configured)).not.toContain('secret-loopback-token')
  expect(configuredToken).toBe('secret-loopback-token')
  await expect(
    client.configure({
      generation: 9,
      configuration: { weather: { port: 1, token: 'replacement' } }
    })
  ).rejects.toThrow(/already configured/i)
  await client.close()
})

test('tool sandbox close aborts and awaits active executor work', async () => {
  const started = deferred<void>()
  let executorClosed = false
  const [server, clientStream] = Harness.duplexPair()
  const served = Harness.serveToolSandbox(server, {
    generation: 10,
    processId: 1_010,
    executor: {
      async invoke(input) {
        started.resolve()
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', resolve, { once: true })
        })
        return { closed: true }
      },
      async close() {
        await new Promise((resolve) => setTimeout(resolve, 25))
        executorClosed = true
      }
    }
  })
  const client = Harness.connectToolSandbox(clientStream)
  const invocation = client.invoke({
    invocationId: 'close-active',
    generation: 10,
    toolName: 'exec',
    input: {}
  })
  await started.promise

  const closing = served.close()
  expect(
    await Promise.race([
      closing.then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 5))
    ])
  ).toBe('pending')
  await closing
  expect(executorClosed).toBe(true)
  await expect(invocation).resolves.toMatchObject({
    status: 'error',
    error: { code: 'TOOL_CANCELLED' }
  })
})

test('tool sandbox readiness rejects unsupported protocol versions', async () => {
  const client = malformedDescriptionClient({
    generation: 1,
    protocolVersion: 2
  })

  await expect(client.ready()).rejects.toThrow(/invalid description/i)
  await client.close()
})

test('tool sandbox readiness rejects unsafe generation identifiers', async () => {
  const zero = malformedDescriptionClient({
    generation: 0,
    protocolVersion: 1
  })

  await expect(zero.ready()).rejects.toThrow(/invalid description/i)
  expect(() =>
    parseToolSandboxDescription(
      descriptionFrame({ generation: 1.5, protocolVersion: 1 })
    )
  ).toThrow(/invalid description/i)
  expect(() =>
    parseToolSandboxDescription(
      descriptionFrame({
        generation: Number.MAX_SAFE_INTEGER + 1,
        protocolVersion: 1
      })
    )
  ).toThrow(/invalid description/i)
  await zero.close()
})

test('tool sandbox readiness rejects unsafe protocol identifiers', async () => {
  const zero = malformedDescriptionClient({
    generation: 1,
    protocolVersion: 0
  })

  await expect(zero.ready()).rejects.toThrow(/invalid description/i)
  expect(() =>
    parseToolSandboxDescription(
      descriptionFrame({ generation: 1, protocolVersion: 1.5 })
    )
  ).toThrow(/invalid description/i)
  await zero.close()
})

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function malformedDescriptionClient({
  generation,
  protocolVersion
}: {
  generation: number
  protocolVersion: number
}) {
  const [server, clientStream] = Harness.duplexPair()
  const rpc = new ToolSandboxRPC(server)
  rpc.onDescribe(async () => ({
    type: 'description',
    component: 'tool-sandbox',
    runtime: 'bare',
    generation,
    processId: 123,
    protocolVersion
  }))
  return Harness.connectToolSandbox(clientStream)
}

function descriptionFrame({
  generation,
  protocolVersion
}: {
  generation: number
  protocolVersion: number
}) {
  return {
    type: 'description',
    component: 'tool-sandbox',
    runtime: 'bare',
    generation,
    processId: 123,
    protocolVersion
  }
}
