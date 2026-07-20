import { loadModelConstants } from '../sdk-constants.js'

/**
 * Virtual `serve.models[*].type` value that opts into the sdcpp-generation
 * plugin's video mode. The user writes `"type": "sdcpp-video"` and this module
 * resolves it to the underlying SDK plugin (`sdcpp-generation`), forces
 * `mode: "video"` into the addon config, and rewrites any nested model-source
 * fields whose value is a known SDK constant name into the full
 * `ModelConstant` object so the P2P registry can fetch the blob.
 */
export const SDCPP_VIDEO_TYPE = 'sdcpp-video'

// sdcpp config fields that accept a model source (path or `ModelConstant`).
// Mode `'video'` ignores the entire `upscaler` block per the SDK schema, so
// we don't recurse into it here.
const NESTED_MODEL_SRC_KEYS = [
  'clipLModelSrc',
  'clipGModelSrc',
  'clipVisionModelSrc',
  't5XxlModelSrc',
  'llmModelSrc',
  'vaeModelSrc',
  'highNoiseDiffusionModelSrc'
] as const

export function resolveSdcppVideoAlias(rawConfig: Record<string, unknown>): {
  sdkType: string
  endpointCategory: string
  config: Record<string, unknown>
} {
  const sdkConstants = loadModelConstants()
  const config: Record<string, unknown> = { ...rawConfig, mode: 'video' }
  for (const key of NESTED_MODEL_SRC_KEYS) {
    const value = config[key]
    // Bare identifiers are looked up as constants; values with `/` or
    // leading `.` are passed through as filesystem paths.
    if (typeof value !== 'string' || value.includes('/') || value.startsWith('.')) continue
    const constant = sdkConstants.get(value)
    if (constant) config[key] = constant
  }
  return {
    sdkType: 'sdcpp-generation',
    endpointCategory: 'video',
    config
  }
}
