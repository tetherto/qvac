import { describe, expect, it } from 'vitest'
import {
  checkCompatibility,
  type ComponentHandshake
} from '../lib/compatibility.ts'

const client: ComponentHandshake = {
  contract: 'qvac.harness',
  protocolVersion: 1,
  capabilities: ['completion', 'inspection'],
  requiredPeerCapabilities: ['inference'],
  buildVersion: '0.0.0-poc'
}

describe('component compatibility', () => {
  it('negotiates shared optional capabilities', () => {
    expect(
      checkCompatibility(client, {
        contract: 'qvac.harness',
        protocolVersion: 1,
        capabilities: ['completion', 'inference'],
        requiredPeerCapabilities: ['completion'],
        buildVersion: '0.0.0-poc'
      })
    ).toEqual({
      compatible: true,
      negotiatedCapabilities: ['completion'],
      missingLocalCapabilities: [],
      missingRemoteCapabilities: []
    })
  })

  it('fails closed on contract or protocol mismatch', () => {
    expect(
      checkCompatibility(client, {
        ...client,
        contract: 'qvac.sync'
      })
    ).toMatchObject({
      compatible: false,
      reason: 'contract mismatch: qvac.harness != qvac.sync'
    })
    expect(
      checkCompatibility(client, {
        ...client,
        protocolVersion: 2
      })
    ).toMatchObject({
      compatible: false,
      reason: 'protocol mismatch: 1 != 2'
    })
  })

  it('reports missing required capabilities on either peer', () => {
    expect(
      checkCompatibility(client, {
        contract: 'qvac.harness',
        protocolVersion: 1,
        capabilities: ['completion'],
        requiredPeerCapabilities: ['completion', 'tracing'],
        buildVersion: '0.0.0-poc'
      })
    ).toEqual({
      compatible: false,
      negotiatedCapabilities: ['completion'],
      missingLocalCapabilities: ['tracing'],
      missingRemoteCapabilities: ['inference'],
      reason: 'required capabilities missing'
    })
  })
})
