import process from 'bare-process'
import { createHarness } from './lib/harness.ts'
import { createSdkDirectAdapter } from './lib/sdk-direct-adapter.ts'
import { serveHarness } from './lib/serve.ts'
import type { HarnessStream } from './lib/transport.ts'

export default async function start(stream: HarnessStream, ready?: () => void) {
  const harness = createHarness({ sdk: await createSdkDirectAdapter() })
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
