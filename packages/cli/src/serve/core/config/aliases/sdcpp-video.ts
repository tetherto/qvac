/**
 * Virtual `serve.models[*].type` value that opts into the sdcpp-generation
 * plugin's video mode. The user writes `"type": "sdcpp-video"` and this module
 * resolves it to the underlying SDK plugin (`sdcpp-generation`) and forces
 * `mode: "video"` into the addon config. Nested `*ModelSrc` constant names are
 * rewritten by `resolveNestedModelSrcConstants` in `config.ts`.
 */
export const SDCPP_VIDEO_TYPE = 'sdcpp-video'

export function resolveSdcppVideoAlias(rawConfig: Record<string, unknown>): {
  sdkType: string
  endpointCategory: string
  config: Record<string, unknown>
} {
  return {
    sdkType: 'sdcpp-generation',
    endpointCategory: 'video',
    config: { ...rawConfig, mode: 'video' }
  }
}
