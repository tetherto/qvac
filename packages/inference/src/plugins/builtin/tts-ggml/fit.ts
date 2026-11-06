import fs from 'bare-fs'
import path from 'bare-path'
import type { TtsFitRequest } from '@qvac/tts-ggml'

import { gpuLayersFromCount } from '@/model-fit/gpu'
import type { TtsRuntimeConfig } from '@/schemas/index'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

interface TtsCommon {
  nGpuLayers: number
  backendsDir?: string
}

const COSYVOICE_COMPANIONS_MISSING =
  'the cosyvoice companion set is not laid out beside the checkpoint'

/**
 * CosyVoice's companion set co-locates the flow, HiFT and voice GGUFs beside
 * the LLM checkpoint, and the loader finds them by name in that directory. The
 * fitter takes explicit paths, so the same directory is read here.
 */
function cosyvoiceRequest(modelPath: string, common: TtsCommon): FitRequestPlan {
  const dir = path.dirname(modelPath)

  let entries: readonly string[]
  try {
    entries = fs.readdirSync(dir) as unknown as string[]
  } catch {
    return { unknown: COSYVOICE_COMPANIONS_MISSING }
  }

  const companion = (matches: (name: string) => boolean): string | undefined => {
    const found = entries.find(matches)
    return found === undefined ? undefined : path.join(dir, found)
  }
  const flowPath = companion((name) => name.includes('-flow-'))
  const hiftPath = companion((name) => name.includes('-hift-'))
  const voicePath = companion((name) => name === 'voice.gguf')

  if (flowPath === undefined || hiftPath === undefined || voicePath === undefined) {
    return { unknown: COSYVOICE_COMPANIONS_MISSING }
  }

  return {
    request: {
      engineType: 'cosyvoice3',
      cosyvoiceLlmModelPath: modelPath,
      cosyvoiceFlowModelPath: flowPath,
      cosyvoiceHiftModelPath: hiftPath,
      cosyvoiceVoiceModelPath: voicePath,
      ...common
    } satisfies TtsFitRequest
  }
}

/** The tts-ggml fit request for a load, built for the voice engine it names. */
export function ttsFitRequest(load: FitLoad): FitRequestPlan {
  const config = (load.modelConfig ?? {}) as TtsRuntimeConfig
  const artifacts = load.artifacts ?? {}
  const workload = load.ttsWorkload

  // The enhancer and denoiser load next to the voice, and no fitter sizes them.
  if (
    artifacts['lavasrEnhancerPath'] !== undefined ||
    artifacts['lavasrDenoiserPath'] !== undefined
  ) {
    return { unknown: 'the LavaSR stages have no fitter' }
  }

  const common: TtsCommon = {
    nGpuLayers: gpuLayersFromCount(config.useGPU, config.nGpuLayers),
    ...(config.backendsDir !== undefined && { backendsDir: config.backendsDir })
  }
  const request = (fit: TtsFitRequest): FitRequestPlan => ({ request: fit })

  switch (config.ttsEngine) {
    case 'supertonic':
      return request({
        engineType: 'supertonic',
        supertonicModelPath: load.modelPath,
        ...common,
        ...(config.ttsNumInferenceSteps !== undefined && { steps: config.ttsNumInferenceSteps })
      })

    case 'parler':
      return request({
        engineType: 'parler',
        parlerModelPath: load.modelPath,
        ...common,
        ...(config.maxFrames !== undefined && { maxFrames: config.maxFrames })
      })

    case 'audio8': {
      const codecDecoderPath = artifacts['audio8CodecDecoderPath']
      if (codecDecoderPath === undefined) {
        return { unknown: 'the audio8 codec decoder is not resolved' }
      }
      const codecEncoderPath = artifacts['audio8CodecEncoderPath']
      return request({
        engineType: 'audio8',
        audio8LmPath: load.modelPath,
        audio8CodecDecoderPath: codecDecoderPath,
        ...(codecEncoderPath !== undefined && { audio8CodecEncoderPath: codecEncoderPath }),
        ...common,
        ...(config.maxFrames !== undefined && { maxFrames: config.maxFrames })
      })
    }

    case 'cosyvoice3':
      return cosyvoiceRequest(load.modelPath, common)

    case 'moss': {
      const decoder = artifacts['mossCodecDecoderPath']
      const encoder = artifacts['mossCodecEncoderPath']
      if (decoder === undefined) return { unknown: 'the moss codec decoder is not resolved' }
      if (workload === undefined || !('promptRows' in workload)) {
        return {
          unknown:
            'a MOSS projection needs a ttsWorkload with promptRows, referenceSamples and streaming'
        }
      }
      if (workload.referenceSamples > 0 && encoder === undefined) {
        return { unknown: 'MOSS reference encoding needs the codec encoder' }
      }
      return request({
        engineType: 'moss',
        mossBackbonePath: load.modelPath,
        mossCodecDecoderPath: decoder,
        ...(encoder !== undefined && { mossCodecEncoderPath: encoder }),
        ...common,
        ...workload,
        ...(config.threads !== undefined && { threads: config.threads }),
        ...(config.streamChunkTokens !== undefined && {
          streamChunkTokens: config.streamChunkTokens
        }),
        ...(config.durationTokens !== undefined && { durationTokens: config.durationTokens })
      })
    }

    case 'moss-sfx':
      if (workload === undefined || !('prompt' in workload)) {
        return {
          unknown: 'a MOSS-SoundEffect projection needs a ttsWorkload with prompt and seconds'
        }
      }
      return request({
        engineType: 'moss-sfx',
        mossSoundEffectPath: load.modelPath,
        ...common,
        ...workload,
        ...(config.negativePrompt !== undefined && { negativePrompt: config.negativePrompt }),
        ...(config.steps !== undefined && { steps: config.steps }),
        ...(config.guidance !== undefined && { guidance: config.guidance }),
        ...(config.shift !== undefined && { shift: config.shift }),
        ...(config.threads !== undefined && { threads: config.threads })
      })

    case 'moss-speech':
      return { unknown: 'MOSS-Speech has no fitter' }

    default: {
      const s3genPath = artifacts['s3genPath']
      if (s3genPath === undefined) {
        return { unknown: 'the chatterbox s3gen checkpoint is not resolved' }
      }
      return request({
        engineType: 'chatterbox',
        t3ModelPath: load.modelPath,
        s3genModelPath: s3genPath,
        ...common,
        ...(config.nCtx !== undefined && config.nCtx > 0 && { nCtx: config.nCtx }),
        ...(config.kvCacheType !== undefined && { kvCacheType: config.kvCacheType })
      })
    }
  }
}
