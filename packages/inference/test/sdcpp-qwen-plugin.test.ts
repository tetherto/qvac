import test from 'brittle'
import Buffer from 'bare-buffer'
import { sdcppConfigSchema, type DiffusionStreamResponse } from '@/schemas/sdcpp-config'
import { loadModelSrcRequestSchema } from '@/schemas/load-model'
import { createDiffusionFitRequest } from '@/model-fit/request/engines/diffusion'

const companions = {
  llmModelSrc: '/models/encoder.gguf',
  projectionModelSrc: { src: 'https://example.com/projector.gguf', name: 'Qwen projector' },
  vaeModelSrc: '/models/vae.safetensors'
}
const companionPaths = {
  llmModelPath: '/cache/encoder.gguf',
  projectionModelPath: '/cache/projector.gguf',
  vaeModelPath: '/cache/vae.safetensors'
}
const companionPathBySource = new Map([
  [companions.llmModelSrc, companionPaths.llmModelPath],
  [companions.projectionModelSrc.src, companionPaths.projectionModelPath],
  [companions.vaeModelSrc, companionPaths.vaeModelPath]
])
const context = {
  modelSrc: '/models/qwen-image-21.gguf',
  modelType: 'sdcpp-generation' as const,
  resolveModelPath: async (src: unknown) => {
    const source = typeof src === 'string' ? src : (src as { src: string }).src
    const resolved = companionPathBySource.get(source)
    if (!resolved) throw new Error('Unexpected companion source')
    return resolved
  }
}

function loadRequest(modelConfig: Record<string, unknown>) {
  return {
    type: 'loadModel',
    modelSrc: context.modelSrc,
    modelType: context.modelType,
    modelConfig
  }
}

test('Qwen projector survives public load validation without a registry descriptor', (t) => {
  const parsed = loadModelSrcRequestSchema.parse(loadRequest(companions))
  t.alike(parsed.modelConfig, { mode: 'diffusion', ...companions })
  t.is(sdcppConfigSchema.parse({}).projectionModelSrc, undefined)
  for (const value of [123, false, []]) {
    t.is(sdcppConfigSchema.safeParse({ projectionModelSrc: value }).success, false)
  }
})

test('Qwen companions resolve into load and fit files without native config source keys', async (t) => {
  const { diffusionPlugin } = await import('@/plugins/builtin/sdcpp-generation/plugin')
  const calls: unknown[] = []
  const resolved = await diffusionPlugin.resolveConfig!(
    sdcppConfigSchema.parse({ ...companions, flash_attn: true }),
    {
      ...context,
      resolveModelPath: async (src) => {
        calls.push(src)
        return context.resolveModelPath(src)
      }
    }
  )
  t.alike(calls, Object.values(companions), 'resolve each user-provided companion once')
  t.alike(resolved.config, { mode: 'diffusion', flash_attn: true })
  t.alike(resolved.artifacts, companionPaths)

  const result = diffusionPlugin.createModel({
    modelId: 'qwen-companions',
    modelPath: context.modelSrc,
    modelConfig: resolved.config,
    artifacts: resolved.artifacts
  })
  const files = (result.model as unknown as { _files: Record<string, string> })._files
  t.alike(files, {
    model: context.modelSrc,
    llm: companionPaths.llmModelPath,
    llmVision: companionPaths.projectionModelPath,
    vae: companionPaths.vaeModelPath
  })
  const fit = createDiffusionFitRequest({
    modelPath: context.modelSrc,
    modelConfig: resolved.config,
    artifacts: resolved.artifacts
  })
  t.ok(fit.supported)
  if (fit.supported && fit.probe.engine === 'diffusion-cpp') {
    t.alike(fit.probe.request.files, files, 'fit accounts for the same projector as load')
    t.alike(fit.probe.request.config, { flash_attn: true })
  }
  await result.model.unload?.()
})

test('text-only Qwen layout resolves without a vision projector or prediction override', async (t) => {
  const { diffusionPlugin } = await import('@/plugins/builtin/sdcpp-generation/plugin')
  const resolved = await diffusionPlugin.resolveConfig!(
    sdcppConfigSchema.parse({
      llmModelSrc: companions.llmModelSrc,
      vaeModelSrc: companions.vaeModelSrc
    }),
    context
  )
  t.alike(resolved.artifacts, {
    llmModelPath: companionPaths.llmModelPath,
    vaeModelPath: companionPaths.vaeModelPath
  })
  t.is(resolved.config.prediction, undefined)
})

test('projectors reject incompatible modes and missing encoders before resolving files', async (t) => {
  const { diffusionPlugin } = await import('@/plugins/builtin/sdcpp-generation/plugin')
  const { ModelLoadFailedError } = await import('@/errors')
  let resolutions = 0
  for (const config of [
    { projectionModelSrc: companions.projectionModelSrc },
    ...(['video', 'world', 'upscale'] as const).map((mode) => ({ mode, ...companions }))
  ]) {
    await t.exception.all(
      async () =>
        diffusionPlugin.resolveConfig!(sdcppConfigSchema.parse(config), {
          ...context,
          resolveModelPath: async () => {
            resolutions++
            return '/models/unused'
          }
        }),
      ModelLoadFailedError
    )
  }
  t.is(resolutions, 0)
})

test('projector resolution preserves the original file failure', async (t) => {
  const { diffusionPlugin } = await import('@/plugins/builtin/sdcpp-generation/plugin')
  const failure = new Error('projector file is unavailable')
  try {
    await diffusionPlugin.resolveConfig!(sdcppConfigSchema.parse(companions), {
      ...context,
      resolveModelPath: async (src) => {
        if (typeof src === 'object' && src.src === companions.projectionModelSrc.src) throw failure
        return context.resolveModelPath(src)
      }
    })
    t.fail('expected projector resolution to reject')
  } catch (error) {
    t.is(error, failure)
  }
})

test('diffusion handler passes ordered reference Buffers and output base64 through with progress and stats', async (t) => {
  const { registerModel, unregisterModel } = await import('@/runtime/model-registry')
  const { diffusionPlugin } = await import('@/plugins/builtin/sdcpp-generation/plugin')
  const output = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaVyzhUAAAAASUVORK5CYII=',
    'base64'
  )
  const received: Record<string, unknown>[] = []
  const modelId = 'qwen-reference-bytes'
  const model = {
    run: async (params: unknown) => {
      received.push(params as Record<string, unknown>)
      return {
        stats: { totalImages: 1, width: 1, height: 1 },
        iterate: async function* () {
          yield '{"step":1,"total":1,"elapsed_ms":5}'
          yield output
        }
      }
    }
  }
  registerModel(modelId, {
    model: model as never,
    path: context.modelSrc,
    config: {},
    modelType: context.modelType
  })
  try {
    for (const refs of [{ init_image: 'AQID' }, { init_images: ['AQID', 'BAUG'] }]) {
      const chunks = []
      const stream = diffusionPlugin.handlers.diffusionStream.handler({
        modelId,
        prompt: 'A portrait.',
        img_cfg_scale: -1,
        ...refs
      }) as AsyncGenerator<DiffusionStreamResponse>
      for await (const chunk of stream) {
        chunks.push(chunk)
      }
      t.is(chunks[0]?.step, 1)
      t.is(chunks[1]?.data, output.toString('base64'), 'output Buffer is forwarded as base64')
      t.is(chunks[1]?.outputIndex, 0)
      t.is(chunks[2]?.done, true)
      t.is(chunks[2]?.stats?.totalImages, 1)
    }
    t.alike(received[0]?.['init_image'], Buffer.from([1, 2, 3]))
    t.alike(received[1]?.['init_images'], [Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6])])
    t.is(received[1]?.['scheduler'], undefined, 'leave native scheduling automatic')
  } finally {
    unregisterModel(modelId)
  }
})
