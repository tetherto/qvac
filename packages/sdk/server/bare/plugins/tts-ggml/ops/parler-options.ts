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

export function assertParlerJobOptionsSupported(
  model: unknown,
  options: ParlerJobOptions,
  handlerName: 'textToSpeech' | 'textToSpeechStream'
) {
  if (Object.keys(options).length === 0) return
  if (hasEngineType(model) && model.getEngineType() === 'parler') return

  throw new PluginRequestValidationFailedError(
    handlerName,
    'description, voiceDescription, voice, emotion, pitch, pace, expressivity, noise, reverb, and quality are only supported by Parler TTS models'
  )
}
