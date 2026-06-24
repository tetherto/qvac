import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'

import { registerQvacProvider } from './provider-config.js'

const configProperties = {
  model: { type: 'string', description: 'QVAC catalog model id to preload and use by default.' },
  host: { type: 'string', description: 'Loopback host for qvac serve.' },
  port: { type: 'number', description: 'Port for qvac serve.' },
  baseUrl: { type: 'string', description: 'OpenAI-compatible base URL exposed by qvac serve.' },
  apiKey: { type: 'string', description: 'Non-empty API key sent by OpenClaw clients.' },
  qvacCommand: { type: 'string', description: 'Command or absolute path used by localService to start qvac.' },
  configPath: { type: 'string', description: 'Path to qvac.config.json used by qvac serve.' },
  cwd: { type: 'string', description: 'Working directory for the local qvac serve process.' },
  ctxSize: { type: 'number', description: 'Context window written into generated QVAC serve config.' },
  reasoningBudget: { type: 'number', description: 'QVAC reasoning budget, where -1 enables reasoning and 0 disables it.' },
  tools: { type: 'boolean', description: 'Enable QVAC tool-call formatting for agent use.' },
  readyTimeoutMs: { type: 'number', description: 'Maximum wait for qvac serve to become healthy.' },
  idleStopMs: {
    type: 'number',
    description: 'OpenClaw localService idle shutdown delay; 0 keeps serve alive until OpenClaw exits.'
  },
  timeoutSeconds: { type: 'number', description: 'HTTP request timeout OpenClaw should use for local QVAC requests.' }
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
  register (api) {
    registerQvacProvider(api)
  }
})
