import { TextDecoder, TextEncoder } from 'bare-encoding'
import {
  BUILD_VERSION,
  PROTOCOL_CONTRACT,
  PROTOCOL_VERSION,
  capabilitiesFor,
  createTraceId,
  encodeMessage,
  isCompatibleHandshake,
  parseMessage,
  type ComponentName,
  type RuntimeEvent,
  type TraceMetadata
} from '../src/protocol.ts'

interface RuntimeIPC {
  on(event: 'data', listener: (data: Uint8Array) => void): void
  write(data: Uint8Array): void
}

export interface RuntimeOptions {
  readonly component: ComponentName
  readonly hardCrash?: () => void
}

export function createRuntime({ component, hardCrash }: RuntimeOptions) {
  return async function start(ipc: RuntimeIPC, ready?: () => void) {
    const metadata = createMetadata(component)
    const decoder = new TextDecoder()
    let buffered = ''

    ipc.on('data', (data) => {
      buffered += decoder.decode(data, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (line.length > 0) handleCommand(ipc, metadata, line, hardCrash)
      }
    })

    sendEvent(ipc, metadata, {
      event: 'runtime.ready',
      requestId: null,
      traceId: createTraceId('ready')
    })
    ready?.()

    return function stop() {
      sendEvent(ipc, metadata, {
        event: 'runtime.stopped',
        requestId: null,
        traceId: createTraceId('stop')
      })
    }
  }
}

function handleCommand(
  ipc: RuntimeIPC,
  metadata: TraceMetadata,
  line: string,
  hardCrash: (() => void) | undefined
) {
  const message = parseMessage(line)
  if (message.type !== 'command') {
    throw new Error('Runtime only accepts command messages from the host')
  }

  if (message.command === 'handshake') {
    const reason = isCompatibleHandshake(message.source, metadata)
    sendEvent(ipc, metadata, {
      event: 'runtime.ready',
      requestId: message.requestId,
      traceId: message.traceId,
      compatible: reason === null,
      ...(reason === null ? {} : { reason })
    })
    return
  }

  if (message.command === 'prepare-suspend') {
    sendEvent(ipc, metadata, {
      event: 'runtime.suspended',
      requestId: message.requestId,
      traceId: message.traceId
    })
    return
  }

  if (message.command === 'resume') {
    sendEvent(ipc, metadata, {
      event: 'runtime.resumed',
      requestId: message.requestId,
      traceId: message.traceId
    })
    return
  }

  if (metadata.component !== 'SDK' || hardCrash === undefined) {
    throw new Error('Hard native crash is only available in the SDK runtime')
  }

  hardCrash()
}

function createMetadata(component: ComponentName): TraceMetadata {
  return {
    component,
    contract: PROTOCOL_CONTRACT,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: capabilitiesFor(component),
    buildVersion: BUILD_VERSION,
    runtimeId: `${component.toLowerCase()}-${createTraceId('runtime')}`,
    processId: null,
    runtime: 'bare'
  }
}

function sendEvent(
  ipc: RuntimeIPC,
  source: TraceMetadata,
  event: Pick<RuntimeEvent, 'event' | 'requestId' | 'traceId'> &
    Partial<Pick<RuntimeEvent, 'compatible' | 'reason'>>
) {
  const message: RuntimeEvent = {
    type: 'event',
    timestamp: Date.now(),
    source,
    ...event
  }
  ipc.write(new TextEncoder().encode(encodeMessage(message)))
}
