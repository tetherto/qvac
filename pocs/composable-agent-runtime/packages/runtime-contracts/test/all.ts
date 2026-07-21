import test from 'brittle'
import {
  checkCompatibility,
  createBoundaryEvent,
  createRuntimeIdentity,
  createTraceId,
  deserializeError,
  isTraceId,
  RuntimeComponentExitedError,
  serializeError,
  type RuntimeHandshake
} from '../src/index.ts'

const client: RuntimeHandshake = {
  contract: 'qvac.harness',
  protocolVersion: 1,
  capabilities: ['completion', 'inspection'],
  requiredPeerCapabilities: ['inference'],
  buildVersion: '0.0.0-poc'
}

test('compatible handshakes negotiate their shared optional capabilities', (t) => {
  const result = checkCompatibility(client, {
    contract: 'qvac.harness',
    protocolVersion: 1,
    capabilities: ['completion', 'inference'],
    requiredPeerCapabilities: ['completion'],
    buildVersion: '0.0.0-poc'
  })

  t.alike(result, {
    compatible: true,
    negotiatedCapabilities: ['completion'],
    missingLocalCapabilities: [],
    missingRemoteCapabilities: []
  })
})

test('handshake fails closed on contract or protocol mismatch', (t) => {
  const wrongContract = checkCompatibility(client, {
    ...client,
    contract: 'qvac.sync'
  })
  const wrongVersion = checkCompatibility(client, {
    ...client,
    protocolVersion: 2
  })

  t.is(wrongContract.compatible, false)
  if (!wrongContract.compatible) {
    t.is(wrongContract.reason, 'contract mismatch: qvac.harness != qvac.sync')
  }
  t.is(wrongVersion.compatible, false)
  if (!wrongVersion.compatible) {
    t.is(wrongVersion.reason, 'protocol mismatch: 1 != 2')
  }
})

test('handshake reports required capabilities missing on either peer', (t) => {
  const result = checkCompatibility(client, {
    contract: 'qvac.harness',
    protocolVersion: 1,
    capabilities: ['completion'],
    requiredPeerCapabilities: ['completion', 'tracing'],
    buildVersion: '0.0.0-poc'
  })

  t.alike(result, {
    compatible: false,
    negotiatedCapabilities: ['completion'],
    missingLocalCapabilities: ['tracing'],
    missingRemoteCapabilities: ['inference'],
    reason: 'required capabilities missing'
  })
})

test('trace IDs are portable, validated, and preserved on boundary events', (t) => {
  const traceId = createTraceId()
  const identity = createRuntimeIdentity({
    component: 'harness',
    runtime: 'bare',
    instanceId: 'harness-1',
    processId: 42,
    buildVersion: '0.0.0-poc'
  })
  const event = createBoundaryEvent({
    type: 'runtime.ready',
    traceId,
    source: identity,
    timestamp: 123,
    details: { capabilities: ['completion'] }
  })

  t.ok(isTraceId(traceId))
  t.is(isTraceId('trace with spaces'), false)
  t.alike(JSON.parse(JSON.stringify(event)), event)
  t.is(event.traceId, traceId)
  t.is(event.source.runtime, 'bare')
})

test('error envelopes survive JSON and retain safe nested causes', (t) => {
  const cause = Object.assign(new Error('socket closed'), { code: 'EPIPE' })
  const error = Object.assign(new Error('request failed', { cause }), {
    code: 'RUNTIME_REQUEST_FAILED',
    recoverable: true
  })
  const traceId = createTraceId()
  const envelope = serializeError(error, { traceId, boundary: 'harness->sdk' })
  const roundTrip = JSON.parse(JSON.stringify(envelope))
  const restored = deserializeError(roundTrip)

  t.alike(roundTrip, envelope)
  t.is(envelope.traceId, traceId)
  t.is(envelope.boundary, 'harness->sdk')
  t.is(envelope.cause?.code, 'EPIPE')
  t.is(restored.message, 'request failed')
  t.is(restored.name, 'Error')
  t.is(restored.code, 'RUNTIME_REQUEST_FAILED')
  t.is(restored.recoverable, true)
  t.is(restored.cause?.message, 'socket closed')
})

test('non-errors become human-readable serializable envelopes', (t) => {
  const envelope = serializeError({ secret: 'not leaked' })

  t.alike(envelope, {
    name: 'Error',
    message: 'Unknown runtime error',
    recoverable: false
  })
})

test('QVAC runtime errors preserve codes and recovery intent on the wire', (t) => {
  const traceId = createTraceId()
  const envelope = serializeError(
    new RuntimeComponentExitedError('sync', {
      code: null,
      signal: 'SIGTERM'
    }),
    { traceId, boundary: 'assistant->sync' }
  )

  t.is(envelope.name, 'RUNTIME_COMPONENT_EXITED')
  t.is(envelope.code, '59003')
  t.is(envelope.recoverable, true)
  t.is(envelope.traceId, traceId)
  t.is(envelope.boundary, 'assistant->sync')
})
