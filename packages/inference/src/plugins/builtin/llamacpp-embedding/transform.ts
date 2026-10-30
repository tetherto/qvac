import type { GGMLConfig } from '@qvac/embed-llamacpp'
import { type EmbedConfig } from '@/schemas/index'

/**
 * Converts an EmbedConfig into the flat string-keyed map the C++ addon expects.
 *
 * Extracted from the plugin so the advisory fit check can build its request
 * from the same transform the real embedding load uses.
 */
export function transformEmbedConfig(embedConfig: EmbedConfig): GGMLConfig {
  const config: GGMLConfig = {
    device: embedConfig.device as 'gpu' | 'cpu',
    gpu_layers: `${embedConfig.gpuLayers}` as `${number}`,
    batch_size: `${embedConfig.batchSize}` as `${number}`
  }

  if (embedConfig.ctxSize !== undefined) {
    config.ctx_size = `${embedConfig.ctxSize}`
  }

  if (embedConfig.poll !== undefined) {
    config.poll = `${embedConfig.poll}`
  }

  if (embedConfig.pollBatch !== undefined) {
    config['poll-batch'] = `${embedConfig.pollBatch}`
  }

  if (embedConfig.backend !== undefined) {
    config.backend = embedConfig.backend.join(',')
  }

  if (embedConfig.flashAttention) {
    config.flash_attn = embedConfig.flashAttention
  }

  if (embedConfig.pooling) {
    config.pooling = embedConfig.pooling
  }

  if (embedConfig.attention) {
    config.attention = embedConfig.attention
  }

  if (typeof embedConfig.embdNormalize === 'number') {
    config.embd_normalize = `${embedConfig.embdNormalize}`
  }

  if (embedConfig.mainGpu !== undefined) {
    config['main-gpu'] =
      typeof embedConfig.mainGpu === 'number' ? `${embedConfig.mainGpu}` : embedConfig.mainGpu
  }

  if (embedConfig.splitMode) {
    config['split-mode'] = embedConfig.splitMode
  }

  if (embedConfig.tensorSplit) {
    config['tensor-split'] = embedConfig.tensorSplit
  }

  if (typeof embedConfig.verbosity === 'number') {
    config.verbosity = `${embedConfig.verbosity}`
  }

  if (embedConfig.openclCacheDir) {
    config.openclCacheDir = embedConfig.openclCacheDir
  }

  if (embedConfig.imageMaxTokens !== undefined) {
    config['image-max-tokens'] = `${embedConfig.imageMaxTokens}`
  }

  if (embedConfig.imageMinTokens !== undefined) {
    config['image-min-tokens'] = `${embedConfig.imageMinTokens}`
  }

  if (embedConfig.imageMaxMegapixels !== undefined) {
    config['image-max-megapixels'] = `${embedConfig.imageMaxMegapixels}`
  }

  if (embedConfig.audioMaxSeconds !== undefined) {
    config['audio-max-seconds'] = `${embedConfig.audioMaxSeconds}`
  }

  if (embedConfig.mmprojNoAudio !== undefined) {
    config['mmproj-no-audio'] = embedConfig.mmprojNoAudio ? '1' : '0'
  }

  if (embedConfig.mmprojUseGpu !== undefined) {
    config['mmproj-use-gpu'] = embedConfig.mmprojUseGpu ? '1' : '0'
  }

  return config
}
