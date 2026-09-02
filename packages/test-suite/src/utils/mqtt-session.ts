import type { IClientOptions, IDisconnectPacket } from 'mqtt'

export function buildMqttProtocolOptions(sessionExpiryInterval?: number) {
  if (sessionExpiryInterval === undefined) {
    return {}
  }

  return {
    protocolVersion: 5,
    clean: false,
    properties: {
      sessionExpiryInterval
    }
  } satisfies IClientOptions
}

export function buildMqttSessionOptions(clientId: string, sessionExpiryInterval?: number) {
  return {
    clientId,
    clean: false,
    ...buildMqttProtocolOptions(sessionExpiryInterval)
  } satisfies IClientOptions
}

export function buildMqttSessionEndOptions(protocolVersion?: IClientOptions['protocolVersion']) {
  if (protocolVersion !== 5) {
    return {}
  }

  return {
    properties: {
      sessionExpiryInterval: 0
    }
  } satisfies Partial<IDisconnectPacket>
}
