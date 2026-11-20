import type { SdcppConfig } from '@qvac/inference/surface'

function acceptConfig(_config: SdcppConfig) {}

acceptConfig({
  backend: 'cuda0',
  paramsBackend: 'diffusion=cpu',
  maxVram: -1,
  streamLayers: true
})
acceptConfig({ paramsBackend: 'diffusion=disk', maxVram: 'cuda0=6,vulkan0=4' })
acceptConfig({ maxVram: 0, streamLayers: false })
// @ts-expect-error removed in favor of parameter residency assignments
acceptConfig({ clip_on_cpu: true })
// @ts-expect-error removed flags must be omitted when false
acceptConfig({ vae_on_cpu: false })
// @ts-expect-error removed in favor of backend assignments
acceptConfig({ control_net_cpu: true })
// @ts-expect-error budgets are numbers or assignment strings
acceptConfig({ maxVram: true })
// @ts-expect-error streaming requires a boolean
acceptConfig({ streamLayers: 'true' })

acceptConfig({
  mode: 'diffusion',
  llmModelSrc: '/models/encoder.gguf',
  projectionModelSrc: '/models/projector.gguf',
  vaeModelSrc: '/models/vae.safetensors'
})
// @ts-expect-error the projector uses the shared model-source type
acceptConfig({ projectionModelSrc: true })

acceptConfig({
  mode: 'diffusion',
  llmModelSrc: '/models/Qwen3.5-9B-Q4_K_M.gguf',
  vaeModelSrc: '/models/flux2-vae_small.safetensors',
  tokenizerSrc: '/models/tokenizer.json'
})
// @ts-expect-error the tokenizer uses the shared model-source type
acceptConfig({ tokenizerSrc: true })

function acceptGeneration(_params: import('@qvac/inference/surface').DiffusionClientParams) {}

acceptGeneration({
  modelId: 'qwen-turbo',
  prompt: 'A red teapot.',
  customSigmas: [1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0],
  cfgScale: 1,
  samplingMethod: 'euler',
  vaeTiling: true,
  vaeTileSize: 64
})
// @ts-expect-error custom sigma schedules contain numbers
acceptGeneration({ modelId: 'qwen-turbo', prompt: 'A teapot.', customSigmas: ['1', '0'] })
