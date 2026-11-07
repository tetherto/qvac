import type { SdcppConfig } from '@qvac/inference/surface'

function acceptConfig(_config: SdcppConfig) {}

acceptConfig({
  backend: 'cuda0',
  params_backend: 'diffusion=cpu',
  max_vram: -1,
  stream_layers: true
})
acceptConfig({ params_backend: 'diffusion=disk', max_vram: 'cuda0=6,vulkan0=4' })
acceptConfig({ max_vram: 0, stream_layers: false })
// @ts-expect-error removed in favor of parameter residency assignments
acceptConfig({ clip_on_cpu: true })
// @ts-expect-error removed flags must be omitted when false
acceptConfig({ vae_on_cpu: false })
// @ts-expect-error removed in favor of backend assignments
acceptConfig({ control_net_cpu: true })
// @ts-expect-error budgets are numbers or assignment strings
acceptConfig({ max_vram: true })
// @ts-expect-error streaming requires a boolean
acceptConfig({ stream_layers: 'true' })

acceptConfig({
  mode: 'diffusion',
  llmModelSrc: '/models/encoder.gguf',
  projectionModelSrc: '/models/projector.gguf',
  vaeModelSrc: '/models/vae.safetensors'
})
// @ts-expect-error the projector uses the shared model-source type
acceptConfig({ projectionModelSrc: true })

function acceptGeneration(_params: import('@qvac/inference/surface').DiffusionClientParams) {}

acceptGeneration({
  modelId: 'qwen-turbo',
  prompt: 'A red teapot.',
  custom_sigmas: [1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0],
  cfg_scale: 1,
  sampling_method: 'euler',
  vae_tiling: true,
  vae_tile_size: 64
})
// @ts-expect-error custom sigma schedules contain numbers
acceptGeneration({ modelId: 'qwen-turbo', prompt: 'A teapot.', custom_sigmas: ['1', '0'] })
