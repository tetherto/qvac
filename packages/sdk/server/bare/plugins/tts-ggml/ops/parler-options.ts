import type { TextToSpeechStreamRequest, TtsRequest } from '@/schemas'
import { PluginRequestValidationFailedError } from '@/utils/errors-server'

export type ParlerJobOptions = Pick<
  TtsRequest,
  | 'description'
  | 'voiceDescription'
  | 'voice'
  | 'emotion'
  | 'pitch'
  | 'pace'
  | 'expressivity'
  | 'noise'
  | 'reverb'
  | 'quality'
>

type ParlerJobOptionsRequest = TtsRequest | TextToSpeechStreamRequest

type EngineAwareModel = {
  getEngineType: () => string
}

function hasEngineType(model: unknown): model is EngineAwareModel {
  return (
    typeof model === 'object' &&
    model !== null &&
    'getEngineType' in model &&
    typeof (model as EngineAwareModel).getEngineType === 'function'
  )
}

export function getParlerJobOptions(request: ParlerJobOptionsRequest): ParlerJobOptions {
  return {
    ...(request.description !== undefined ? { description: request.description } : {}),
    ...(request.voiceDescription !== undefined
      ? { voiceDescription: request.voiceDescription }
      : {}),
    ...(request.voice !== undefined ? { voice: request.voice } : {}),
    ...(request.emotion !== undefined ? { emotion: request.emotion } : {}),
    ...(request.pitch !== undefined ? { pitch: request.pitch } : {}),
    ...(request.pace !== undefined ? { pace: request.pace } : {}),
    ...(request.expressivity !== undefined ? { expressivity: request.expressivity } : {}),
    ...(request.noise !== undefined ? { noise: request.noise } : {}),
    ...(request.reverb !== undefined ? { reverb: request.reverb } : {}),
    ...(request.quality !== undefined ? { quality: request.quality } : {})
  }
}

// Per-call conditioning keys shared by the engines that support them.
// CosyVoice3 accepts the cross-engine emotion/pace pair; everything else in
// the description/template surface remains Parler-only.
const CROSS_ENGINE_CONDITIONING_KEYS = ['emotion', 'pace'] as const

export function assertParlerJobOptionsSupported(
  model: unknown,
  options: ParlerJobOptions,
  handlerName: 'textToSpeech' | 'textToSpeechStream'
) {
  const setKeys = Object.keys(options)
  if (setKeys.length === 0) return

  const engine = hasEngineType(model) ? model.getEngineType() : undefined
  if (engine === 'parler') return

  if (engine === 'cosyvoice3') {
    const parlerOnlyKeys = setKeys.filter(
      (key) => !(CROSS_ENGINE_CONDITIONING_KEYS as readonly string[]).includes(key)
    )
    if (parlerOnlyKeys.length > 0) {
      throw new PluginRequestValidationFailedError(
        handlerName,
        `${parlerOnlyKeys.join(', ')} ${parlerOnlyKeys.length === 1 ? 'is' : 'are'} only supported by Parler TTS models; CosyVoice3 supports emotion and pace`
      )
    }
    // CosyVoice3 is trained on one instruction per synthesis; a request that
    // engages both channels always conflicts regardless of the loaded config.
    if (
      options.emotion !== undefined &&
      options.pace !== undefined &&
      options.pace !== 'moderate'
    ) {
      throw new PluginRequestValidationFailedError(
        handlerName,
        'CosyVoice3 accepts one conditioning control per synthesis; set either emotion or a non-moderate pace, not both'
      )
    }
    return
  }

  throw new PluginRequestValidationFailedError(
    handlerName,
    'description, voiceDescription, voice, emotion, pitch, pace, expressivity, noise, reverb, and quality are only supported by Parler TTS and CosyVoice3 models (CosyVoice3: emotion and pace only)'
  )
}
