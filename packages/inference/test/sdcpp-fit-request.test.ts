import test from 'brittle'

import type { DiffusionFitRequest, EsrganFitRequest, WorldFitRequest } from '@qvac/diffusion-cpp'
import { sdcppFitRequest } from '@/plugins/builtin/sdcpp-generation/fit'
import { DEFAULT_WORLD_FIT_STEPS } from '@/plugins/builtin/sdcpp-generation/world-config'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

function fitLoad(
  modelConfig: Record<string, unknown>,
  artifacts?: Record<string, string>
): FitLoad {
  return { modelPath: '/models/model.gguf', modelConfig, artifacts, isShardedModel: false }
}

function requestOf<T>(plan: FitRequestPlan): T | undefined {
  return 'request' in plan ? (plan.request as T) : undefined
}

test('image: carries the files and engine config the load builds', (t) => {
  const request = requestOf<DiffusionFitRequest>(
    sdcppFitRequest(
      fitLoad(
        { mode: 'diffusion', flash_attn: true, vae_tiling: true },
        {
          llmModelPath: '/models/encoder.gguf',
          projectionModelPath: '/models/projector.gguf',
          vaeModelPath: '/models/vae.safetensors'
        }
      )
    )
  )

  t.alike(request?.files, {
    model: '/models/model.gguf',
    llm: '/models/encoder.gguf',
    llmVision: '/models/projector.gguf',
    vae: '/models/vae.safetensors'
  })
  t.alike(
    request?.config,
    { flash_attn: true, vae_tiling: true },
    'mode stays out of the engine config'
  )
  t.alike(request?.workload, { vaeTiling: true })
  t.absent(request !== undefined && 'mode' in request, 'an image load is the default fit mode')
})

test('image: a configured upscaler is fitted together with its model', (t) => {
  const request = requestOf<DiffusionFitRequest>(
    sdcppFitRequest(
      fitLoad(
        { mode: 'diffusion', upscaler: { tile_size: 128, threads: 2 } },
        { esrganModelPath: '/models/esrgan.pth' }
      )
    )
  )

  t.is(request?.files.esrgan, '/models/esrgan.pth')
  t.alike(request?.config, { upscaler_tile_size: 128, upscaler_threads: 2 })
  t.alike(request?.workload, { upscaleRepeats: 1 })
})

test('image: an upscaler without its model is refused as the load refuses it', (t) => {
  t.exception(
    () => sdcppFitRequest(fitLoad({ mode: 'diffusion', upscaler: { tile_size: 128 } })),
    /upscaler\.model_src is required/
  )
})

test('video: the layout the load selects, projected at the frames run generates', (t) => {
  const request = requestOf<DiffusionFitRequest>(
    sdcppFitRequest(
      fitLoad(
        { mode: 'video', threads: 4, vae_tiling: true },
        { t5XxlModelPath: '/models/umt5.gguf', vaeModelPath: '/models/wan-vae.safetensors' }
      )
    )
  )

  t.alike(request?.files, {
    model: '/models/model.gguf',
    vae: '/models/wan-vae.safetensors',
    t5Xxl: '/models/umt5.gguf'
  })
  t.alike(request?.config, { threads: 4, vae_tiling: true })
  t.alike(request?.workload, { vaeTiling: true, videoFrames: 33 })
})

test('video: a load without its VAE is refused as the load refuses it', (t) => {
  t.exception(
    () => sdcppFitRequest(fitLoad({ mode: 'video' }, { t5XxlModelPath: '/models/umt5.gguf' })),
    /vaeModelSrc is required in video mode/
  )
})

test('upscale: the ESRGAN checkpoint with the load upscaler config', (t) => {
  const request = requestOf<EsrganFitRequest>(
    sdcppFitRequest(fitLoad({ mode: 'upscale', device: 'cpu', upscaler: { tile_size: 64 } }))
  )

  t.is(request?.mode, 'upscale')
  t.alike(request?.files, { esrgan: '/models/model.gguf' })
  t.alike(request?.config, { upscaler_tile_size: 64, device: 'cpu' })
  t.alike(request?.workload, { upscaleRepeats: 1 })
})

test('world: the session files, the session settings and the walk to size', (t) => {
  const request = requestOf<WorldFitRequest>(
    sdcppFitRequest(
      fitLoad(
        { mode: 'world', world: { seed: 42, fitSteps: 250 } },
        { taehvModelPath: '/models/taehv.gguf', seedScenePath: '/models/scene.safetensors' }
      )
    )
  )

  t.is(request?.mode, 'world')
  t.alike(request?.files, {
    model: '/models/model.gguf',
    taehv: '/models/taehv.gguf',
    scene: '/models/scene.safetensors'
  })
  t.alike(request?.config, { seed: 42 })
  t.alike(request?.workload, { walkSteps: 250 })
})

test('world: the walk defaults to the fit steps the schema documents', (t) => {
  const request = requestOf<WorldFitRequest>(
    sdcppFitRequest(
      fitLoad(
        { mode: 'world' },
        { taehvModelPath: '/models/taehv.gguf', seedScenePath: '/models/scene.safetensors' }
      )
    )
  )

  t.alike(request?.workload, { walkSteps: DEFAULT_WORLD_FIT_STEPS })
})

test('world: a session without a seed scene is unknown', (t) => {
  const plan = sdcppFitRequest(fitLoad({ mode: 'world' }, { taehvModelPath: '/models/taehv.gguf' }))
  t.ok('unknown' in plan)
})

test('world: a session without its decoder is refused as the load refuses it', (t) => {
  t.exception(
    () =>
      sdcppFitRequest(fitLoad({ mode: 'world' }, { seedScenePath: '/models/scene.safetensors' })),
    /taehvModelSrc is required in world mode/
  )
})

test('a split model is unknown', (t) => {
  const plan = sdcppFitRequest({ ...fitLoad({ mode: 'diffusion' }), isShardedModel: true })
  t.ok('unknown' in plan)
})
