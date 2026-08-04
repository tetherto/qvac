import AbortController from '#abort-controller'
import fs from '#fs-promises'
import os from '#os'
import path from '#path'
import process from '#process'
import { createImageGenerationTooling } from '../lib/image-generation.ts'
import { createSdkDirectAdapter } from '../lib/sdk-direct-adapter.ts'
import type { HarnessJsonValue } from '../lib/types.ts'
import type { HarnessToolInvocation } from '../lib/tool-broker.ts'

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
])

if (process.env.QVAC_REAL_MODEL_SMOKE !== '1') {
  throw new Error('run explicitly with `bun run test:smoke:diffusion`')
}
const MODEL = process.env.QVAC_DIFFUSION_MODEL
if (!MODEL) {
  throw new Error(
    'diffusion smoke requires QVAC_DIFFUSION_MODEL to name a pre-provisioned model'
  )
}

await fs.access(MODEL).catch(() => {
  throw new Error(
    `diffusion smoke requires the pre-provisioned model at ${MODEL}; no download was attempted`
  )
})
const smokeRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), 'qvac-diffusion-smoke-')
)
await fs.chmod(smokeRoot, 0o700)
const attachmentRoot = path.join(smokeRoot, 'attachments')
const sdk = await createSdkDirectAdapter({
  diffusion: {
    model: MODEL,
    modelConfig: { prediction: 'v' }
  }
})
const tooling = await createImageGenerationTooling({
  sdk,
  attachmentRoot
})
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort('diffusion smoke timeout'), 8 * 60_000)
const startedAt = Date.now()

try {
  const invocation: HarnessToolInvocation = {
    agentId: 'task-5-smoke',
    runId: 'task-5-smoke',
    operationId: 'task-5-smoke',
    call: {
      id: 'task-5-smoke-generation',
      name: 'generate_image',
      arguments: {
        prompt: 'a small red sailboat on a calm blue lake, minimalist illustration',
        width: 512,
        height: 512,
        steps: 1,
        seed: 424242
      }
    },
    grants: [{ name: 'generate_image', scope: null }],
    signal: controller.signal
  }
  const result = await tooling.broker.execute(invocation)
  if (!isRecord(result) || result.status !== 'success') {
    throw new Error('diffusion smoke did not return success')
  }
  const attachment = result.attachment
  if (attachment === undefined || !isRecord(attachment)) {
    throw new Error('diffusion smoke returned no attachment metadata')
  }
  const outputPath = attachment.path
  const byteLength = attachment.byteLength
  if (typeof outputPath !== 'string' || typeof byteLength !== 'number') {
    throw new Error('diffusion smoke returned invalid attachment metadata')
  }
  if (
    attachment.mimeType !== 'image/png' ||
    attachment.width !== 512 ||
    attachment.height !== 512 ||
    !path.isAbsolute(outputPath) ||
    byteLength <= PNG_SIGNATURE.byteLength
  ) {
    throw new Error('diffusion smoke attachment metadata is invalid')
  }
  const bytes = await fs.readFile(outputPath)
  if (
    bytes.byteLength !== byteLength ||
    PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)
  ) {
    throw new Error('diffusion smoke output is not the expected PNG')
  }
  const siblingNames = await fs.readdir(path.dirname(outputPath))
  if (siblingNames.some((name) => name.includes('.partial'))) {
    throw new Error('diffusion smoke left a partial attachment')
  }
  const stats = result.stats
  console.log(JSON.stringify({
    status: 'success',
    elapsedMs: Date.now() - startedAt,
    outputPath,
    byteLength,
    stats
  }))
} catch (error) {
  console.error(
    '[diffusion-smoke] generation failed:',
    error instanceof Error ? error.stack : String(error)
  )
  throw error
} finally {
  clearTimeout(timeout)
  try {
    await tooling.close()
    await sdk.close()
  } catch (error) {
    console.error(
      '[diffusion-smoke] close failed:',
      error instanceof Error ? error.stack : String(error)
    )
    throw error
  }
}

function isRecord(
  value: HarnessJsonValue
): value is { [key: string]: HarnessJsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
