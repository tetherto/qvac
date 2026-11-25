import type { SdcppConfig } from '@/schemas/index'
import { registryUrlSchema } from '@/schemas/load-model'
import { modelInputToSrcSchema } from '@/schemas/model-src-utils'
import { coremlBundleNameOf } from '@/utils/cache/layout'

/** What each Core ML sidecar replaces, for the refusal off Apple platforms. */
const SIDECARS = {
  coremlUnetModelSrc: "the GGUF's own UNet",
  coremlTaeDecoderModelSrc: 'the ggml decoder'
} as const

const IMAGE_ONLY_SOURCES = [
  'taesdModelSrc',
  'coremlUnetModelSrc',
  'coremlTaeDecoderModelSrc'
] as const

/**
 * Why the load's Core ML sidecars or tiny autoencoder cannot load, or
 * `undefined` when they can. It applies the addon's own refusals before any
 * companion is downloaded, and refuses a source that cannot deliver a
 * directory: a compiled `.mlmodelc` bundle is one, so it comes from a local
 * path or the registry, never a single-file HTTP or Hyperdrive download.
 */
export function coremlSidecarRefusal(
  config: Pick<SdcppConfig, 'mode' | (typeof IMAGE_ONLY_SOURCES)[number]>,
  platform: string | undefined
): string | undefined {
  const imageOnly = IMAGE_ONLY_SOURCES.find((key) => config[key] !== undefined)
  if (imageOnly && (config.mode ?? 'diffusion') !== 'diffusion') {
    return `modelConfig.${imageOnly} is image diffusion only. Use mode: 'diffusion' or remove it.`
  }

  for (const [key, replaced] of Object.entries(SIDECARS) as [keyof typeof SIDECARS, string][]) {
    const src = config[key]
    if (src === undefined) continue

    if (platform !== undefined && platform !== 'darwin' && platform !== 'ios') {
      return (
        `modelConfig.${key} is an Apple Core ML sidecar, which loads on macOS and iOS only. ` +
        `Omit it on ${platform} to run ${replaced} instead.`
      )
    }

    const location = modelInputToSrcSchema.parse(src)
    const scheme = location.match(/^(https?|pear):\/\//)?.[1]
    if (scheme) {
      return (
        `modelConfig.${key} takes a local .mlmodelc directory or a registry:// Core ML bundle. ` +
        `A ${scheme}:// source downloads a single file, and a compiled bundle is a directory.`
      )
    }
    if (location.startsWith('registry://')) {
      const url = registryUrlSchema.safeParse(location)
      if (!url.success || coremlBundleNameOf(url.data.registryPath) === undefined) {
        return (
          `modelConfig.${key} must name a compiled .mlmodelc bundle directory in the ` +
          `registry, not a file: ${location}`
        )
      }
    }
  }
  return undefined
}
