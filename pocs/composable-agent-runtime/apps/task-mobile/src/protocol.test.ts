import { describe, expect, test } from 'bun:test'
import {
  BUILD_VERSION,
  PROTOCOL_CONTRACT,
  PROTOCOL_VERSION,
  capabilitiesFor,
  createTraceId,
  encodeMessage,
  isCompatibleHandshake,
  parseMessage,
  type RuntimeCommand,
  type TraceMetadata
} from './protocol.ts'

describe('mobile runtime protocol', () => {
  test('round-trips commands with boundary trace metadata', () => {
    const source = metadata('MobileHost', 'hermes', null)
    const command: RuntimeCommand = {
      type: 'command',
      command: 'handshake',
      requestId: createTraceId('request'),
      traceId: createTraceId(),
      timestamp: Date.now(),
      source
    }

    expect(parseMessage(encodeMessage(command).trim())).toEqual(command)
    expect(command.traceId).toMatch(/^trc_/)
    expect(command.source.runtimeId).toMatch(/^runtime_/)
  })

  test('rejects contract mismatches and missing runtime capabilities', () => {
    const host = metadata('MobileHost', 'hermes', null)
    const incompatible = {
      ...metadata('SDK', 'bare', 42),
      contract: 'qvac.other'
    }
    expect(isCompatibleHandshake(host, incompatible)).toContain(
      'contract mismatch'
    )

    const missingCapability = {
      ...metadata('SDK', 'bare', 42),
      capabilities: []
    }
    expect(isCompatibleHandshake(host, missingCapability)).toBe(
      'runtime handshake capability missing'
    )
  })

  test('advertises native abort only for the SDK runtime', () => {
    expect(capabilitiesFor('SDK')).toContain('test-only-native-abort')
    expect(capabilitiesFor('Sync')).not.toContain('test-only-native-abort')
    expect(capabilitiesFor('Harness')).not.toContain('test-only-native-abort')
  })
})

function metadata(
  component: TraceMetadata['component'],
  runtime: TraceMetadata['runtime'],
  processId: number | null
): TraceMetadata {
  return {
    component,
    contract: PROTOCOL_CONTRACT,
    protocolVersion: PROTOCOL_VERSION,
    capabilities:
      component === 'MobileHost'
        ? ['host-runner-broker', 'protocol-handshake', 'trace-metadata']
        : capabilitiesFor(component),
    buildVersion: BUILD_VERSION,
    runtimeId: createTraceId('runtime'),
    processId,
    runtime
  }
}
