import type { Duplex } from 'streamx'
import type { HarnessJsonValue } from './types.ts'
import type { SdkRuntimeEvent, SdkRuntimePort } from './sdk-runtime-port.ts'

interface TransportRequest {
  readonly kind: 'request'
  readonly id: number
  readonly method: 'loadModel' | 'completion' | 'cancel' | 'heartbeat' | 'close'
  readonly payload: HarnessJsonValue
}

interface TransportResponse {
  readonly kind: 'response'
  readonly id: number
  readonly ok: boolean
  readonly payload?: HarnessJsonValue
  readonly error?: string
}

interface TransportStreamEvent {
  readonly kind: 'stream-event'
  readonly streamId: string
  readonly payload: HarnessJsonValue
}

interface TransportStreamEnd {
  readonly kind: 'stream-end'
  readonly streamId: string
}

type TransportFrame =
  | TransportRequest
  | TransportResponse
  | TransportStreamEvent
  | TransportStreamEnd

interface PublicSdkHistoryMessage {
  readonly role: string
  readonly content: string
}

interface PublicSdkCompletionInput {
  readonly modelId: string
  readonly history: readonly PublicSdkHistoryMessage[]
  readonly stream: true
}

type PublicSdkCompletionEvent =
  | { readonly type: 'thinkingDelta'; readonly text: string }
  | { readonly type: 'contentDelta'; readonly text: string }
  | {
      readonly type: 'toolCall'
      readonly call: {
        readonly name: string
        readonly arguments: Readonly<Record<string, HarnessJsonValue>>
      }
    }
  | {
      readonly type: 'toolResult'
      readonly name: string
      readonly result: HarnessJsonValue
    }
  | {
      readonly type: 'completionStats'
      readonly stats: Readonly<Record<string, number>>
    }
  | {
      readonly type: 'completionDone'
      readonly stopReason: 'eos' | 'cancelled' | 'error'
      readonly error?: { readonly message: string }
    }

export interface PublicSdkLike {
  loadModel(input: {
    readonly modelSrc: string
    readonly modelType: string
  }): Promise<string>
  completion(input: PublicSdkCompletionInput): {
    readonly requestId: string
    readonly events: AsyncIterable<PublicSdkCompletionEvent>
  }
  cancel(input: { readonly requestId: string }): Promise<void>
  heartbeat(): Promise<{ readonly ok: boolean }>
  close(): Promise<void>
}

export interface HostSdkTransportServer {
  close(): Promise<void>
}

interface PendingResponse {
  readonly resolve: (value: HarnessJsonValue) => void
  readonly reject: (error: Error) => void
}

interface StreamQueue {
  readonly events: TransportStreamEvent[]
  readonly waiters: Array<(event: TransportStreamEvent | null) => void>
  ended: boolean
}

interface ActiveCancellationRun {
  remoteRequestId: string | null
  cancelled: boolean
}

export function createHostSdkTransportServer(
  stream: Duplex,
  sdk: PublicSdkLike
): HostSdkTransportServer {
  const activeRequests = new Set<string>()
  const state = createTransportState(stream, {
    onClosed() {
      void cancelActiveRequests()
    }
  })
  let nextStreamId = 1
  let closing = false

  state.onRequest(async (frame) => {
    if (frame.method === 'loadModel') {
      const payload = asRecord(frame.payload)
      const modelSrc = readString(payload, 'modelSrc')
      const modelType = readString(payload, 'modelType')
      const modelId = await sdk.loadModel({ modelSrc, modelType })
      state.respond(frame.id, true, { modelId })
      return
    }

    if (frame.method === 'completion') {
      const payload = asRecord(frame.payload)
      const modelId = readString(payload, 'modelId')
      const history = readHistory(payload)
      const run = sdk.completion({
        modelId,
        history,
        stream: true
      })
      activeRequests.add(run.requestId)
      const streamId = `completion-${nextStreamId++}`
      state.respond(frame.id, true, { requestId: run.requestId, streamId })
      void pumpCompletionEvents(state, streamId, run.events, {
        onFinished() {
          activeRequests.delete(run.requestId)
        }
      })
      return
    }

    if (frame.method === 'cancel') {
      const payload = asRecord(frame.payload)
      const requestId = readString(payload, 'requestId')
      await sdk.cancel({ requestId })
      activeRequests.delete(requestId)
      state.respond(frame.id, true, null)
      return
    }

    if (frame.method === 'heartbeat') {
      const heartbeat = await sdk.heartbeat()
      state.respond(frame.id, true, { ok: heartbeat.ok })
      return
    }

    if (frame.method === 'close') {
      if (!closing) {
        closing = true
        await cancelActiveRequests()
        await sdk.close()
      }
      state.respond(frame.id, true, null)
      return
    }
  })

  return {
    async close() {
      if (!closing) {
        closing = true
        await cancelActiveRequests()
        await sdk.close()
      }
      state.close()
    }
  }

  async function cancelActiveRequests() {
    if (activeRequests.size === 0) return
    const pending = [...activeRequests]
    activeRequests.clear()
    for (const requestId of pending) {
      try {
        await sdk.cancel({ requestId })
      } catch {}
    }
  }
}

export function createWorkerSdkRuntimePort(stream: Duplex): SdkRuntimePort {
  const state = createTransportState(stream)
  const activeRuns = new Map<string, ActiveCancellationRun>()
  const pendingLocalCancel = new Set<string>()
  let closed = false

  return {
    async loadModel({ model, traceId }) {
      const payload = await state.request('loadModel', {
        modelSrc: model,
        modelType: 'llamacpp-completion',
        traceId
      })
      const response = asRecord(payload)
      return { modelId: readString(response, 'modelId') }
    },
    completion({ requestId, traceId, modelId, messages, signal }) {
      activeRuns.set(requestId, { remoteRequestId: null, cancelled: false })
      return {
        requestId,
        events: (async function* () {
          const history = messages.map((message) => ({
            role: message.role,
            content: message.content
          }))
          const payload = await state.request('completion', {
            requestId,
            traceId,
            modelId,
            history
          })
          const response = asRecord(payload)
          const remoteRequestId = readString(response, 'requestId')
          const run = activeRuns.get(requestId)
          if (run) run.remoteRequestId = remoteRequestId
          const streamId = readString(response, 'streamId')
          if (pendingLocalCancel.has(requestId) || signal.aborted) {
            pendingLocalCancel.delete(requestId)
            await cancelRemoteRequest(requestId)
          }
          try {
            for await (const frame of state.stream(streamId)) {
              const mapped = mapPublicEvent(frame.payload)
              if (mapped === null) continue
              yield mapped
            }
          } finally {
            if (signal.aborted) await cancelRemoteRequest(requestId)
            activeRuns.delete(requestId)
          }
        })()
      }
    },
    async cancel({ requestId }) {
      await cancelRemoteRequest(requestId)
    },
    async heartbeat() {
      const payload = await state.request('heartbeat', null)
      const response = asRecord(payload)
      return { ok: readBoolean(response, 'ok') }
    },
    async close() {
      if (closed) return
      closed = true
      activeRuns.clear()
      pendingLocalCancel.clear()
      await state.request('close', null).catch(() => {})
      state.close()
    }
  }

  async function cancelRemoteRequest(localRequestId: string) {
    const run = activeRuns.get(localRequestId)
    if (!run) {
      await state.request('cancel', { requestId: localRequestId })
      return
    }
    if (run.cancelled) return
    if (run.remoteRequestId === null) {
      pendingLocalCancel.add(localRequestId)
      return
    }
    run.cancelled = true
    await state.request('cancel', { requestId: run.remoteRequestId })
  }
}

async function pumpCompletionEvents(
  state: ReturnType<typeof createTransportState>,
  streamId: string,
  events: AsyncIterable<PublicSdkCompletionEvent>,
  {
    onFinished
  }: {
    readonly onFinished?: () => void
  } = {}
) {
  let sentDone = false
  try {
    for await (const event of events) {
      if (!safePushStream(state, streamId, encodePublicEvent(event))) return
      if (event.type === 'completionDone') sentDone = true
    }
    if (!sentDone) {
      if (!safePushStream(state, streamId, {
        type: 'completionDone',
        stopReason: 'eos'
      })) return
    }
  } catch (error) {
    safePushStream(state, streamId, {
      type: 'completionDone',
      stopReason: 'error',
      error: { message: message(error) }
    })
  } finally {
    safeEndStream(state, streamId)
    onFinished?.()
  }
}

function createTransportState(
  stream: Duplex,
  { onClosed }: { readonly onClosed?: () => void } = {}
) {
  const pending = new Map<number, PendingResponse>()
  const queues = new Map<string, StreamQueue>()
  const handlers: Array<(frame: TransportRequest) => Promise<void>> = []
  let nextRequestId = 1
  let ended = false
  let buffered = ''

  stream.on('data', (chunk: unknown) => {
    if (!(chunk instanceof Uint8Array)) return
    buffered += decodeAscii(chunk)
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (line.length === 0) continue
      const frame = parseFrame(line)
      if (frame === null) continue
      void dispatch(frame).catch(() => {})
    }
  })
  stream.on('close', () => {
    failAll(new Error('transport disconnected'))
  })
  stream.on('error', (error: unknown) => {
    failAll(new Error(message(error)))
  })

  async function dispatch(frame: TransportFrame) {
    if (frame.kind === 'response') {
      const pendingResponse = pending.get(frame.id)
      if (!pendingResponse) return
      pending.delete(frame.id)
      if (frame.ok) pendingResponse.resolve(frame.payload ?? null)
      else pendingResponse.reject(new Error(frame.error ?? 'transport request failed'))
      return
    }
    if (frame.kind === 'stream-event') {
      const queue = queueFor(frame.streamId)
      const waiter = queue.waiters.shift()
      if (waiter) waiter(frame)
      else queue.events.push(frame)
      return
    }
    if (frame.kind === 'stream-end') {
      const queue = queueFor(frame.streamId)
      queue.ended = true
      for (const waiter of queue.waiters.splice(0)) waiter(null)
      queues.delete(frame.streamId)
      return
    }
    for (const handler of handlers) {
      try {
        await handler(frame)
      } catch (error) {
        try {
          respond(frame.id, false, null, message(error))
        } catch {}
      }
    }
  }

  function queueFor(streamId: string): StreamQueue {
    const existing = queues.get(streamId)
    if (existing) return existing
    const next: StreamQueue = { events: [], waiters: [], ended: false }
    queues.set(streamId, next)
    return next
  }

  function send(frame: TransportFrame) {
    if (ended) throw new Error('transport disconnected')
    const data = `${stringifyAsciiJson(frame)}\n`
    stream.write(encodeAscii(data))
  }

  function request(method: TransportRequest['method'], payload: HarnessJsonValue) {
    const id = nextRequestId++
    return new Promise<HarnessJsonValue>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try {
        send({
          kind: 'request',
          id,
          method,
          payload
        })
      } catch (error) {
        pending.delete(id)
        reject(new Error(message(error)))
      }
    })
  }

  function respond(
    id: number,
    ok: boolean,
    payload: HarnessJsonValue,
    error?: string
  ) {
    send({
      kind: 'response',
      id,
      ok,
      ...(ok ? { payload } : { error: error ?? 'request failed' })
    })
  }

  function pushStream(streamId: string, payload: HarnessJsonValue) {
    send({ kind: 'stream-event', streamId, payload })
  }

  function endStream(streamId: string) {
    send({ kind: 'stream-end', streamId })
  }

  async function* streamEvents(streamId: string) {
    const queue = queueFor(streamId)
    try {
      while (true) {
        if (queue.events.length > 0) {
          const event = queue.events.shift()
          if (event) yield event
          continue
        }
        if (queue.ended) return
        const next = await new Promise<TransportStreamEvent | null>((resolve) => {
          queue.waiters.push(resolve)
        })
        if (next === null) return
        yield next
      }
    } finally {
      queues.delete(streamId)
    }
  }

  function failAll(error: Error) {
    if (ended) return
    ended = true
    for (const pendingResponse of pending.values()) {
      pendingResponse.reject(error)
    }
    pending.clear()
    for (const queue of queues.values()) {
      queue.ended = true
      for (const waiter of queue.waiters.splice(0)) waiter(null)
    }
    onClosed?.()
  }

  return {
    request,
    respond,
    pushStream,
    endStream,
    stream: streamEvents,
    onRequest(handler: (frame: TransportRequest) => Promise<void>) {
      handlers.push(handler)
    },
    close() {
      failAll(new Error('transport closed'))
      stream.destroy()
    }
  }
}

function stringifyAsciiJson(value: unknown) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

function encodeAscii(value: string) {
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index++) {
    bytes[index] = value.charCodeAt(index)
  }
  return bytes
}

function decodeAscii(value: Uint8Array) {
  let decoded = ''
  for (const byte of value) decoded += String.fromCharCode(byte)
  return decoded
}

function safePushStream(
  state: ReturnType<typeof createTransportState>,
  streamId: string,
  payload: HarnessJsonValue
) {
  try {
    state.pushStream(streamId, payload)
    return true
  } catch {
    return false
  }
}

function safeEndStream(
  state: ReturnType<typeof createTransportState>,
  streamId: string
) {
  try {
    state.endStream(streamId)
  } catch {}
}

function parseFrame(line: string): TransportFrame | null {
  const raw = parseJson(line)
  if (raw === null) return null
  const kind = raw.kind
  if (kind === 'request') {
    const id = raw.id
    const method = raw.method
    if (
      typeof id !== 'number' ||
      (method !== 'loadModel' &&
        method !== 'completion' &&
        method !== 'cancel' &&
        method !== 'heartbeat' &&
        method !== 'close')
    ) {
      return null
    }
    return {
      kind,
      id,
      method,
      payload: readJsonValue(raw, 'payload') ?? null
    }
  }
  if (kind === 'response') {
    const id = raw.id
    const ok = raw.ok
    if (typeof id !== 'number' || typeof ok !== 'boolean') return null
    return {
      kind,
      id,
      ok,
      payload: readJsonValue(raw, 'payload'),
      error: typeof raw.error === 'string' ? raw.error : undefined
    }
  }
  if (kind === 'stream-event') {
    const streamId = raw.streamId
    if (typeof streamId !== 'string') return null
    return {
      kind,
      streamId,
      payload: readJsonValue(raw, 'payload') ?? null
    }
  }
  if (kind === 'stream-end') {
    const streamId = raw.streamId
    if (typeof streamId !== 'string') return null
    return {
      kind,
      streamId
    }
  }
  return null
}

function readHistory(payload: Record<string, HarnessJsonValue>) {
  const history = payload.history
  if (!Array.isArray(history)) throw new Error('completion history must be an array')
  return history.map((entry) => {
    const record = asRecord(entry)
    return {
      role: readString(record, 'role'),
      content: readString(record, 'content')
    }
  })
}

function mapPublicEvent(payload: HarnessJsonValue): SdkRuntimeEvent | null {
  const event = asRecord(payload)
  const type = readString(event, 'type')
  if (type === 'thinkingDelta') {
    return { type: 'thinking-delta', text: readString(event, 'text') }
  }
  if (type === 'contentDelta') {
    return { type: 'content-delta', text: readString(event, 'text') }
  }
  if (type === 'toolCall') {
    const call = asRecord(event.call ?? null)
    const args = asRecord(call.arguments ?? null)
    return {
      type: 'tool-call',
      name: readString(call, 'name'),
      arguments: args
    }
  }
  if (type === 'toolResult') {
    return {
      type: 'tool-result',
      name: readString(event, 'name'),
      result: event.result ?? null
    }
  }
  if (type === 'completionStats') {
    const statsRaw = asRecord(event.stats ?? null)
    const metrics: Record<string, number> = {}
    for (const [key, value] of Object.entries(statsRaw)) {
      if (typeof value === 'number') metrics[key] = value
    }
    return { type: 'metrics', metrics }
  }
  if (type === 'completionDone') {
    const stopReason = readString(event, 'stopReason')
    if (stopReason === 'cancelled') return { type: 'cancelled' }
    if (stopReason === 'error') {
      const error = asRecord(event.error ?? null)
      return {
        type: 'error',
        message: readString(error, 'message')
      }
    }
    return null
  }
  return {
    type: 'error',
    message: `unmapped SDK event: ${type}`
  }
}

function asRecord(
  value: HarnessJsonValue
): Record<string, HarnessJsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('transport payload must be an object')
  }
  return value as Record<string, HarnessJsonValue>
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function readJsonValue(
  source: Record<string, unknown>,
  key: string
): HarnessJsonValue | undefined {
  const value = source[key]
  if (isHarnessJsonValue(value)) return value
  return undefined
}

function isHarnessJsonValue(value: unknown): value is HarnessJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (Array.isArray(value)) return value.every((entry) => isHarnessJsonValue(entry))
  if (typeof value === 'object') {
    for (const entry of Object.values(value)) {
      if (!isHarnessJsonValue(entry)) return false
    }
    return true
  }
  return false
}

function encodePublicEvent(event: PublicSdkCompletionEvent): HarnessJsonValue {
  if (event.type === 'thinkingDelta' || event.type === 'contentDelta') {
    return { type: event.type, text: event.text }
  }
  if (event.type === 'toolCall') {
    return {
      type: event.type,
      call: {
        name: event.call.name,
        arguments: event.call.arguments
      }
    }
  }
  if (event.type === 'toolResult') {
    return {
      type: event.type,
      name: event.name,
      result: event.result
    }
  }
  if (event.type === 'completionStats') {
    return {
      type: event.type,
      stats: event.stats
    }
  }
  return {
    type: event.type,
    stopReason: event.stopReason,
    ...(event.error ? { error: { message: event.error.message } } : {})
  }
}

function readString(
  value: Record<string, HarnessJsonValue>,
  key: string
): string {
  const selected = value[key]
  if (typeof selected !== 'string') {
    throw new Error(`transport payload "${key}" must be a string`)
  }
  return selected
}

function readBoolean(
  value: Record<string, HarnessJsonValue>,
  key: string
): boolean {
  const selected = value[key]
  if (typeof selected !== 'boolean') {
    throw new Error(`transport payload "${key}" must be a boolean`)
  }
  return selected
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
