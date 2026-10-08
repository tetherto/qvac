import type { EsrganUpscalerConfig } from '@qvac/diffusion-cpp'
import type { SdcppConfig } from '@/schemas/index'

export function flattenUpscalerKeys(upscaler: SdcppConfig['upscaler']) {
  if (!upscaler) return {}
  return {
    ...(upscaler.tile_size !== undefined && { upscaler_tile_size: upscaler.tile_size }),
    ...(upscaler.direct !== undefined && { upscaler_direct: upscaler.direct }),
    ...(upscaler.offload_params_to_cpu !== undefined && {
      upscaler_offload_params_to_cpu: upscaler.offload_params_to_cpu
    }),
    ...(upscaler.threads !== undefined && { upscaler_threads: upscaler.threads })
  } satisfies Partial<EsrganUpscalerConfig>
}

export function toEsrganAddonConfig(config: SdcppConfig) {
  return {
    ...flattenUpscalerKeys(config.upscaler),
    ...(config.device !== undefined && { device: config.device }),
    ...(config.verbosity !== undefined && { verbosity: config.verbosity })
  } satisfies EsrganUpscalerConfig
}
