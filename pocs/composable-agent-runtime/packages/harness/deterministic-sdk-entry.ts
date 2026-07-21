import process from 'bare-process'
import { createHarness } from './lib/harness.ts'
import { serveHarness } from './lib/serve.ts'
import type { HarnessStream } from './lib/transport.ts'

export default async function start(stream: HarnessStream, ready?: () => void) {
  const harness = createHarness({
    sdk: {
      async loadModel({ model }) {
        return { modelId: model }
      },
      completion({ requestId, messages }) {
        const prompt = [...messages]
          .reverse()
          .find((message) => message.role === 'user')?.content ?? ''
        return {
          requestId,
          events: (async function* () {
            yield {
              type: 'content-delta' as const,
              text: `deterministic: ${prompt}`
            }
          })()
        }
      },
      async cancel() {},
      async heartbeat() {
        return { ok: true }
      },
      async close() {}
    }
  })
  serveHarness(stream, harness, () => ({
    component: 'sdk',
    runtime: 'bare',
    instanceId: `sdk-${process.pid}`,
    processId: process.pid,
    contract: 'qvac.sdk-runtime-port',
    protocolVersion: 1,
    capabilities: ['model.load', 'completion.stream', 'lifecycle'],
    buildVersion: '0.0.0-poc'
  }))
  ready?.()
  return () => harness.close()
}
