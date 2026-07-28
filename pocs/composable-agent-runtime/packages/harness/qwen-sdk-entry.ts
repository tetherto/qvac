import process from 'bare-process'
import { createHarness } from './lib/harness.ts'
import { createHarnessLogger, loggingFromArgv } from './lib/logger.ts'
import { createSdkDirectAdapter } from './lib/sdk-direct-adapter.ts'
import { serveHarness } from './lib/serve.ts'
import type { HarnessStream } from './lib/transport.ts'

const logging = loggingFromArgv(process.argv)

export default async function start(stream: HarnessStream, ready?: () => void) {
  const logger = createHarnessLogger(logging)
  const harness = createHarness({
    sdk: await createSdkDirectAdapter({ logger }),
    logging
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
