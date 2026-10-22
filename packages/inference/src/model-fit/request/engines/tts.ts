import fs from 'bare-fs'
import path from 'bare-path'
import type { TtsFitRequest } from '@qvac/tts-ggml'

import type { TtsFitWorkload } from '@/schemas/assess-model-fit'
import type { TtsRuntimeConfig } from '@/schemas/index'
import type { FitRequestPlan } from '@/model-fit/request/create'
import { gpuLayersFromCount } from '@/model-fit/request/gpu'

export interface TtsFitRequestParams {
  ttsWorkload?: TtsFitWorkload | undefined
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
  nGpuLayers: number
  marginBytes?: number
  lavasrEnhancerPath?: string
  lavasrDenoiserPath?: string
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
        cosyvoiceLlmModelPath: modelPath,
        cosyvoiceFlowModelPath: flowPath,
        cosyvoiceHiftModelPath: hiftPath,
        cosyvoiceVoiceModelPath: voicePath,
        ...common
      }
    }
  }
}

export function createTtsFitRequest(params: TtsFitRequestParams): FitRequestPlan {
  const config = (params.modelConfig ?? {}) as TtsRuntimeConfig
  const artifacts = params.artifacts ?? {}

  const lavasrEnhancerPath = artifacts['lavasrEnhancerPath']
  const lavasrDenoiserPath = artifacts['lavasrDenoiserPath']

  const common: TtsCommon = {
    nGpuLayers: gpuLayersFromCount(config.useGPU, config.nGpuLayers),
    ...(config.backendsDir !== undefined && { backendsDir: config.backendsDir }),
    ...(params.marginBytes !== undefined && { marginBytes: params.marginBytes }),
    ...(lavasrEnhancerPath !== undefined && { lavasrEnhancerPath }),
    ...(lavasrDenoiserPath !== undefined && { lavasrDenoiserPath })
  }

  const supported = (request: TtsFitRequest): FitRequestPlan => ({
    supported: true,
    probe: { engine: 'tts-ggml', request }
  })

  switch (config.ttsEngine) {
    case 'supertonic':
      return supported({
        engineType: 'supertonic',
        supertonicModelPath: params.modelPath,
        ...common,
        ...(config.ttsNumInferenceSteps !== undefined && { steps: config.ttsNumInferenceSteps })
      })

    case 'parler':
      return supported({
        engineType: 'parler',
        parlerModelPath: params.modelPath,
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
        audio8LmPath: params.modelPath,
        audio8CodecDecoderPath: codecDecoderPath,
        ...(codecEncoderPath !== undefined && { audio8CodecEncoderPath: codecEncoderPath }),
        ...common,
        ...(config.maxFrames !== undefined && { maxFrames: config.maxFrames })
      })
    }

    case 'cosyvoice3':
      return cosyvoiceRequest(params.modelPath, common)

    case 'moss': {
      const decoder = artifacts['mossCodecDecoderPath']
      const encoder = artifacts['mossCodecEncoderPath']
      if (!decoder) return unsupported('the moss codec decoder is not resolved')
      if (!params.ttsWorkload || !('promptRows' in params.ttsWorkload)) {
        return unsupported(
          'MOSS fit requires ttsWorkload with promptRows, referenceSamples and streaming'
        )
      }
      if (params.ttsWorkload.referenceSamples > 0 && !encoder) {
        return unsupported('MOSS reference encoding requires the codec encoder')
      }
      return supported({
        engineType: 'moss',
        mossBackbonePath: params.modelPath,
        mossCodecDecoderPath: decoder,
        ...(encoder ? { mossCodecEncoderPath: encoder } : {}),
        ...common,
        ...params.ttsWorkload,
        ...(config.threads !== undefined ? { threads: config.threads } : {}),
        ...(config.streamChunkTokens !== undefined
          ? { streamChunkTokens: config.streamChunkTokens }
          : {}),
        ...(config.durationTokens !== undefined ? { durationTokens: config.durationTokens } : {})
      })
    }
    case 'moss-sfx': {
      if (!params.ttsWorkload || !('prompt' in params.ttsWorkload)) {
        return unsupported('MOSS-SoundEffect fit requires ttsWorkload with prompt and seconds')
      }
      return supported({
        engineType: 'moss-sfx',
        mossSoundEffectPath: params.modelPath,
        ...common,
        ...params.ttsWorkload,
        ...(config.negativePrompt !== undefined ? { negativePrompt: config.negativePrompt } : {}),
        ...(config.steps !== undefined ? { steps: config.steps } : {}),
        ...(config.guidance !== undefined ? { guidance: config.guidance } : {}),
        ...(config.shift !== undefined ? { shift: config.shift } : {}),
        ...(config.threads !== undefined ? { threads: config.threads } : {})
      })
    }
    case 'moss-speech':
      return unsupported('the addon does not provide MOSS-Speech memory fit')

    default: {
      const s3genPath = artifacts['s3genPath']
      if (s3genPath === undefined) {
        return unsupported('the chatterbox s3gen checkpoint is not resolved')
      }
      return supported({
        engineType: 'chatterbox',
        t3ModelPath: params.modelPath,
        s3genModelPath: s3genPath,
        ...common,
        ...(config.nCtx !== undefined && config.nCtx > 0 && { nCtx: config.nCtx }),
        ...(config.kvCacheType !== undefined && { kvCacheType: config.kvCacheType })
      })
    }
  }
}
