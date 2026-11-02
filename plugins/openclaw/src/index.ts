import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'

import { registerQvacProvider } from './provider-config.js'

export { createQvacServeModels, resolveOptions } from './provider-config.js'

const configProperties = {
  model: { type: 'string', description: 'QVAC catalog model id to preload and use by default.' },
  host: { type: 'string', description: 'Loopback host for qvac serve.' },
  port: {
    type: 'number',
    description: 'Port for qvac serve; 0 (default) lets it bind any free port.'
  },
  baseUrl: {
    type: 'string',
    description: 'Ignored. The plugin connects to the port its own qvac serve reports.'
  },
  apiKey: {
    type: 'string',
    minLength: 32,
    maxLength: 128,
    pattern: '^[A-Za-z0-9_][A-Za-z0-9_-]{31,127}$',
    description: 'Optional base64url bearer key to materialize into the private QVAC key file.'
  },
  qvacCommand: {
    type: 'string',
    description: 'Command or absolute path used to start qvac serve.'
  },
  cwd: { type: 'string', description: 'Working directory for the local qvac serve process.' },
  ctxSize: {
    type: 'number',
    description: 'Context window written into generated QVAC serve config.'
  },
  reasoningBudget: {
    type: 'number',
    description: 'QVAC reasoning budget, where -1 enables reasoning and 0 disables it.'
  },
  tools: { type: 'boolean', description: 'Enable QVAC tool-call formatting for agent use.' },
  readyTimeoutMs: {
    type: 'number',
    description: 'Maximum wait for qvac serve to report its port.'
  },
  idleStopMs: {
    type: 'number',
    description: 'Ignored. qvac serve stops when OpenClaw exits.'
  },
  timeoutSeconds: {
    type: 'number',
    description: 'HTTP request timeout OpenClaw should use for local QVAC requests.'
  }
}

export default definePluginEntry({
  id: 'qvac',
  name: 'QVAC',
  description: 'Local QVAC provider for OpenClaw',
  configSchema: () => ({
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: configProperties
    }
  }),
  register(api) {
    registerQvacProvider(api)
  }
})
