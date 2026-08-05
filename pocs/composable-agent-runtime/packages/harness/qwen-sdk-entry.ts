import process from 'bare-process'
import Buffer from 'bare-buffer'
import { createHarnessService } from './lib/harness.ts'
import { createHarnessLogger } from './lib/logger.ts'
import { installHarnessConfigFromArgv } from './lib/config.ts'
import { createSdkDirectAdapter } from './lib/sdk-direct-adapter.ts'
import { serveHarness } from './lib/serve.ts'
import type { HarnessStream } from './lib/transport.ts'

installHarnessConfigFromArgv(process.argv)
const diffusion = parseDiffusionConfig(argument('--diffusion-config='))

export default async function start(stream: HarnessStream, ready?: () => void) {
  const logger = createHarnessLogger()
  const harness = createHarnessService({
    sdk: await createSdkDirectAdapter({
      logger,
      ...(diffusion
        ? {
            diffusion: {
              model: diffusion.model,
              ...(diffusion.prediction
                ? { modelConfig: { prediction: diffusion.prediction } }
                : {})
            }
          }
        : {})
    })
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

function argument(prefix: string) {
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length)
}

function parseDiffusionConfig(encoded: string | undefined) {
  if (!encoded) return undefined
  return JSON.parse(Buffer.from(encoded, 'base64').toString()) as {
    readonly model: string
    readonly prediction?: 'auto' | 'eps' | 'v' | 'edm_v' | 'flow' | 'flux2_flow'
  }
}
