import fs from 'bare-fs'
import path from 'bare-path'
import type { TtsFitRequest } from '@qvac/tts-ggml'

import type { TtsRuntimeConfig } from '@/schemas/index'
import type { FitRequestPlan } from '@/resources/model-fit/native-probe/create-fit-request'
import { gpuLayersFromCount } from '@/resources/model-fit/native-probe/engines/gpu'

export interface TtsFitRequestParams {
  modelPath: string
  modelConfig: unknown
  artifacts?: Record<string, string> | undefined
  marginBytes?: number | undefined
}

function unsupported(detail: string): FitRequestPlan {
  return { supported: false, detail }
}

/**
 * CosyVoice's companion set co-locates the flow, HiFT and voice GGUFs beside
 * the LLM checkpoint, and the loader finds them by name in that directory. The
 * fitter takes explicit paths, so the same directory is read here.
 */
function cosyvoiceCompanion(
  entries: readonly string[],
  dir: string,
  matches: (name: string) => boolean
): string | undefined {
  const found = entries.find(matches)
  return found === undefined ? undefined : path.join(dir, found)
}

interface TtsCommon {
  gpuLayers: number
  marginBytes?: number
}

function cosyvoiceRequest(modelPath: string, common: TtsCommon): FitRequestPlan {
  const dir = path.dirname(modelPath)

  let entries: readonly string[]
  try {
    entries = fs.readdirSync(dir) as unknown as string[]
  } catch {
    return unsupported('the cosyvoice companion set is not laid out beside the checkpoint')
  }

  const flowPath = cosyvoiceCompanion(entries, dir, (name) => name.includes('-flow-'))
  const hiftPath = cosyvoiceCompanion(entries, dir, (name) => name.includes('-hift-'))
  const voicePath = cosyvoiceCompanion(entries, dir, (name) => name === 'voice.gguf')

  if (flowPath === undefined || hiftPath === undefined || voicePath === undefined) {
    return unsupported('the cosyvoice companion set is not laid out beside the checkpoint')
  }

  return {
    supported: true,
    probe: {
      engine: 'tts-ggml',
      request: {
        engineType: 'cosyvoice3',
        llmPath: modelPath,
        flowPath,
        hiftPath,
        voicePath,
        ...common
      }
    }
  }
}

export function createTtsFitRequest(params: TtsFitRequestParams): FitRequestPlan {
  const config = (params.modelConfig ?? {}) as TtsRuntimeConfig
  const artifacts = params.artifacts ?? {}

  const common: TtsCommon = {
    gpuLayers: gpuLayersFromCount(config.useGPU, config.nGpuLayers),
    ...(params.marginBytes !== undefined && { marginBytes: params.marginBytes })
  }

  const supported = (request: TtsFitRequest): FitRequestPlan => ({
    supported: true,
    probe: { engine: 'tts-ggml', request }
  })

  switch (config.ttsEngine) {
    case 'supertonic':
      return supported({
        engineType: 'supertonic',
        modelPath: params.modelPath,
        ...common,
        ...(config.ttsNumInferenceSteps !== undefined && { steps: config.ttsNumInferenceSteps })
      })

    case 'parler':
      return supported({
        engineType: 'parler',
        modelPath: params.modelPath,
        ...common,
        ...(config.maxFrames !== undefined && { maxFrames: config.maxFrames })
      })

    case 'audio8': {
      const codecDecoderPath = artifacts['audio8CodecDecoderPath']
      if (codecDecoderPath === undefined) {
        return unsupported('the audio8 codec decoder is not resolved')
      }
      const codecEncoderPath = artifacts['audio8CodecEncoderPath']
      return supported({
        engineType: 'audio8',
        lmPath: params.modelPath,
        codecDecoderPath,
        // Supplying the encoder projects voice cloning, which the decoder
        // alone cannot do.
        ...(codecEncoderPath !== undefined && { codecEncoderPath }),
        ...common,
        ...(config.maxFrames !== undefined && { maxFrames: config.maxFrames })
      })
    }

    case 'cosyvoice3':
      return cosyvoiceRequest(params.modelPath, common)

    default: {
      const s3genPath = artifacts['s3genPath']
      if (s3genPath === undefined) {
        return unsupported('the chatterbox s3gen checkpoint is not resolved')
      }
      return supported({
        engineType: 'chatterbox',
        t3Path: params.modelPath,
        s3genPath,
        ...common,
        ...(config.nCtx !== undefined && config.nCtx > 0 && { contextSize: config.nCtx }),
        ...(config.kvCacheType !== undefined && { kvCacheType: config.kvCacheType })
      })
    }
  }
}
