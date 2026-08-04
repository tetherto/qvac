import AbortController from '#abort-controller'
import ToolSandboxRPC from '../../spec/tool-sandbox/hrpc/index.js'
import type { HarnessStream } from '../transport.ts'
import type { HarnessJsonValue } from '../types.ts'
import type {
  ToolSandbox,
  ToolSandboxDescription,
  ToolSandboxResult
} from './types.ts'

type WireFrame = Record<string, HarnessJsonValue | undefined>

export interface ToolSandboxExecutionRequest {
  readonly invocationId: string
  readonly generation: number
  readonly toolName: string
  readonly input: Readonly<Record<string, HarnessJsonValue>>
  readonly signal: {
    readonly aborted: boolean
    addEventListener(
      type: 'abort',
      listener: () => void,
      options?: { readonly once?: boolean }
    ): void
    removeEventListener?(type: 'abort', listener: () => void): void
  }
}

export interface ToolSandboxExecutor {
  invoke(input: ToolSandboxExecutionRequest): Promise<HarnessJsonValue>
  close?(): Promise<void>
}

export interface ServeToolSandboxOptions {
  readonly generation: number
  readonly processId: number
  readonly executor?: ToolSandboxExecutor
  readonly configure?: (
    configuration: Readonly<Record<string, HarnessJsonValue>>
  ) => ToolSandboxExecutor
}

export function serveToolSandbox(
  stream: HarnessStream,
  {
    generation,
    processId,
    executor: initialExecutor,
    configure
  }: ServeToolSandboxOptions
) {
  const rpc = new ToolSandboxRPC(stream)
  let executor = initialExecutor
  let configured = false
  const active = new Map<
    string,
    {
      readonly generation: number
      readonly controller: AbortController
      readonly done: Promise<void>
      finish(): void
    }
  >()
  let closing: Promise<void> | undefined

  rpc.onDescribe(async () => ({
    type: 'description',
    component: 'tool-sandbox',
    runtime: 'bare',
    generation,
    processId,
    protocolVersion: 1
  }))
  rpc.onConfigure(async (frame: WireFrame) => {
    const request = parseConfigure(frame)
    if (!request) {
      return errorResult(
        '',
        generation,
        'INVALID_CONFIGURATION',
        'invalid tool sandbox configuration'
      )
    }
    if (request.generation !== generation) {
      return errorResult(
        '',
        generation,
        'GENERATION_MISMATCH',
        'sandbox generation mismatch'
      )
    }
    if (!configure) {
      return errorResult(
        '',
        generation,
        'CONFIGURATION_UNSUPPORTED',
        'tool sandbox does not accept configuration'
      )
    }
    if (configured) {
      return errorResult(
        '',
        generation,
        'ALREADY_CONFIGURED',
        'tool sandbox is already configured'
      )
    }
    try {
      executor = configure(request.configuration)
      configured = true
      return {
        type: 'configured',
        generation
      }
    } catch (cause) {
      return errorResult(
        '',
        generation,
        'INVALID_CONFIGURATION',
        cause instanceof Error ? cause.message : String(cause)
      )
    }
  })
  rpc.onInvoke(async (frame: WireFrame) => {
    const request = parseInvoke(frame)
    if (!request) {
      return errorResult(
        stringField(frame.invocationId, 'invalid'),
        generation,
        'INVALID_REQUEST',
        'invalid tool sandbox invocation'
      )
    }
    if (request.generation !== generation) {
      return errorResult(
        request.invocationId,
        generation,
        'GENERATION_MISMATCH',
        'sandbox generation mismatch'
      )
    }
    if (active.has(request.invocationId)) {
      return errorResult(
        request.invocationId,
        generation,
        'DUPLICATE_INVOCATION',
        'tool invocation is already active'
      )
    }
    if (!executor) {
      return errorResult(
        request.invocationId,
        generation,
        'NOT_CONFIGURED',
        'tool sandbox executor is not configured'
      )
    }

    const controller = new AbortController()
    const completion = deferred()
    const running = {
      generation,
      controller,
      done: completion.promise,
      finish: completion.resolve
    }
    active.set(request.invocationId, running)
    try {
      const value = await executor.invoke({ ...request, signal: controller.signal })
      if (controller.signal.aborted) {
        return cancelledResult(request.invocationId, generation)
      }
      if (!isJsonValue(value)) {
        return errorResult(
          request.invocationId,
          generation,
          'INVALID_RESULT',
          'tool returned a non-JSON result'
        )
      }
      return {
        type: 'success',
        invocationId: request.invocationId,
        generation,
        value
      }
    } catch (cause) {
      if (controller.signal.aborted) {
        return cancelledResult(request.invocationId, generation)
      }
      return errorResult(
        request.invocationId,
        generation,
        'TOOL_EXECUTION_FAILED',
        cause instanceof Error ? cause.message : String(cause)
      )
    } finally {
      running.finish()
      if (active.get(request.invocationId) === running) {
        active.delete(request.invocationId)
      }
    }
  })
  rpc.onCancel(async (frame: WireFrame) => {
    const request = parseCancel(frame)
    if (request?.generation === generation) {
      const running = active.get(request.invocationId)
      if (running?.generation === request.generation) {
        running.controller.abort('tool invocation cancelled')
      }
    }
    return {
      type: 'cancelled',
      invocationId: request?.invocationId ?? '',
      generation
    }
  })

  return {
    async close() {
      closing ??= closeServer()
      await closing
    }
  }

  async function closeServer() {
    const running = [...active.values()]
    for (const invocation of running) {
      invocation.controller.abort('tool sandbox closed')
    }
    await executor?.close?.()
    await Promise.all(running.map((invocation) => invocation.done))
    active.clear()
    stream.destroy()
  }
}

export function connectToolSandbox(stream: HarnessStream): ToolSandbox {
  const rpc = new ToolSandboxRPC(stream)
  let closed = false
  return {
    async ready() {
      assertOpen(closed)
      return parseToolSandboxDescription(
        await rpc.describe({ type: 'describe' })
      )
    },
    async configure(input) {
      assertOpen(closed)
      const frame = await rpc.configure({
        type: 'configure',
        generation: input.generation,
        configuration: input.configuration
      })
      if (
        frame.type === 'configured' &&
        frame.generation === input.generation
      ) {
        return { generation: input.generation }
      }
      if (frame.type === 'error' && typeof frame.message === 'string') {
        throw new Error(frame.message)
      }
      throw new Error('tool sandbox returned an invalid configuration result')
    },
    async invoke(input) {
      assertOpen(closed)
      return parseResult(
        await rpc.invoke({
          type: 'invoke',
          invocationId: input.invocationId,
          generation: input.generation,
          toolName: input.toolName,
          input: input.input
        })
      )
    },
    async cancel(input) {
      if (closed) return
      await rpc.cancel({
        type: 'cancel',
        invocationId: input.invocationId,
        generation: input.generation
      })
    },
    async close() {
      if (closed) return
      closed = true
      stream.destroy()
    }
  }
}

function parseInvoke(frame: WireFrame) {
  if (
    frame.type !== 'invoke' ||
    typeof frame.invocationId !== 'string' ||
    typeof frame.generation !== 'number' ||
    !Number.isSafeInteger(frame.generation) ||
    typeof frame.toolName !== 'string' ||
    !isJsonRecord(frame.input)
  ) {
    return null
  }
  return {
    invocationId: frame.invocationId,
    generation: frame.generation,
    toolName: frame.toolName,
    input: frame.input
  }
}

function parseCancel(frame: WireFrame) {
  if (
    frame.type !== 'cancel' ||
    typeof frame.invocationId !== 'string' ||
    typeof frame.generation !== 'number' ||
    !Number.isSafeInteger(frame.generation)
  ) {
    return null
  }
  return {
    invocationId: frame.invocationId,
    generation: frame.generation
  }
}

function parseConfigure(frame: WireFrame) {
  if (
    frame.type !== 'configure' ||
    typeof frame.generation !== 'number' ||
    !Number.isSafeInteger(frame.generation) ||
    !isJsonRecord(frame.configuration)
  ) {
    return null
  }
  return {
    generation: frame.generation,
    configuration: frame.configuration
  }
}

export function parseToolSandboxDescription(
  frame: WireFrame
): ToolSandboxDescription {
  if (
    frame.type !== 'description' ||
    frame.component !== 'tool-sandbox' ||
    frame.runtime !== 'bare' ||
    !isPositiveSafeInteger(frame.generation) ||
    !isPositiveSafeInteger(frame.processId) ||
    !isPositiveSafeInteger(frame.protocolVersion) ||
    frame.protocolVersion !== 1
  ) {
    throw new Error('tool sandbox returned an invalid description')
  }
  return {
    component: frame.component,
    runtime: frame.runtime,
    generation: frame.generation,
    processId: frame.processId,
    protocolVersion: frame.protocolVersion
  }
}

function parseResult(frame: WireFrame): ToolSandboxResult {
  if (
    typeof frame.invocationId !== 'string' ||
    typeof frame.generation !== 'number'
  ) {
    throw new Error('tool sandbox returned an invalid result')
  }
  if (frame.type === 'success' && isJsonValue(frame.value)) {
    return {
      status: 'success',
      invocationId: frame.invocationId,
      generation: frame.generation,
      value: frame.value
    }
  }
  if (
    frame.type === 'error' &&
    typeof frame.code === 'string' &&
    typeof frame.message === 'string'
  ) {
    return {
      status: 'error',
      invocationId: frame.invocationId,
      generation: frame.generation,
      error: { code: frame.code, message: frame.message }
    }
  }
  throw new Error('tool sandbox returned an invalid result')
}

function errorResult(
  invocationId: string,
  generation: number,
  code: string,
  message: string
) {
  return {
    type: 'error',
    invocationId,
    generation,
    code,
    message
  }
}

function cancelledResult(invocationId: string, generation: number) {
  return errorResult(
    invocationId,
    generation,
    'TOOL_CANCELLED',
    'tool invocation cancelled'
  )
}

function isJsonRecord(
  value: HarnessJsonValue | undefined
): value is Record<string, HarnessJsonValue> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  )
}

function isJsonValue(
  value: HarnessJsonValue | undefined
): value is HarnessJsonValue {
  if (value === null) return true
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true
  }
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isJsonRecord(value)
}

function stringField(value: HarnessJsonValue | undefined, fallback: string) {
  return typeof value === 'string' ? value : fallback
}

function assertOpen(closed: boolean) {
  if (closed) throw new Error('tool sandbox is closed')
}

function isPositiveSafeInteger(
  value: HarnessJsonValue | undefined
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  )
}

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
