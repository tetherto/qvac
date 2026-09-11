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
