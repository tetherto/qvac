import { getModelEntry } from '@/runtime/model-registry'
import type { TtsRequest } from '@/schemas/index'
import { PluginRequestValidationFailedError } from '@/errors/index'
import { getTtsEngineType } from './parler-options'

const soundEffectKeys = ['seconds', 'negativePrompt', 'steps', 'guidance', 'shift'] as const
const speechKeys = [
  'audio',
  'sampleRate',
  'messages',
  'systemPrompt',
  'replyVoice',
  'replyVoiceSampleRate',
  'textReply',
  'maxReplySeconds',
  'maxNewTokens',
  'greedy',
  'temperature',
  'topP',
  'topK'
] as const

/** Reject incompatible controls before the addon can silently ignore them. */
export function getMossJobOptions(model: unknown, request: TtsRequest) {
  const engine = getTtsEngineType(model)
  const batch = engine === 'moss-sfx' || engine === 'moss-speech'
  if (
    batch &&
    (request.sentenceStream ||
      request.sentenceStreamLocale !== undefined ||
      request.sentenceStreamMaxChunkScalars !== undefined)
  ) {
    throw new PluginRequestValidationFailedError(
      'textToSpeech',
      `${engine} does not support sentence-stream controls`
    )
  }
  for (const key of soundEffectKeys) {
    if (request[key] !== undefined && engine !== 'moss-sfx') {
      throw new PluginRequestValidationFailedError('textToSpeech', `${key} requires moss-sfx`)
    }
  }
  for (const key of speechKeys) {
    if (request[key] !== undefined && engine !== 'moss-speech') {
      throw new PluginRequestValidationFailedError('textToSpeech', `${key} requires moss-speech`)
    }
  }
  const defaults = getModelEntry(request.modelId)?.local.config as
    | {
        seconds?: number
        negativePrompt?: string
        steps?: number
        guidance?: number
        shift?: number
      }
    | undefined
  const soundEffect =
    engine === 'moss-sfx'
      ? {
          seconds: request.seconds ?? defaults?.seconds,
          negativePrompt: request.negativePrompt ?? defaults?.negativePrompt,
          steps: request.steps ?? defaults?.steps,
          guidance: request.guidance ?? defaults?.guidance,
          shift: request.shift ?? defaults?.shift
        }
      : {}
  return {
    ...Object.fromEntries(Object.entries(soundEffect).filter(([, value]) => value !== undefined)),
    ...(request.audio !== undefined ? { audio: new Float32Array(request.audio) } : {}),
    ...(request.sampleRate !== undefined ? { sampleRate: request.sampleRate } : {}),
    ...(request.messages !== undefined
      ? {
          messages: request.messages.map((message) => ({
            role: message.role,
            ...(message.text !== undefined ? { text: message.text } : {}),
            ...(message.audio !== undefined ? { audio: new Float32Array(message.audio) } : {}),
            ...(message.sampleRate !== undefined ? { sampleRate: message.sampleRate } : {})
          }))
        }
      : {}),
    ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
    ...(request.replyVoice !== undefined
      ? { replyVoice: new Float32Array(request.replyVoice) }
      : {}),
    ...(request.replyVoiceSampleRate !== undefined
      ? { replyVoiceSampleRate: request.replyVoiceSampleRate }
      : {}),
    ...(request.textReply !== undefined ? { textReply: request.textReply } : {}),
    ...(request.maxReplySeconds !== undefined ? { maxReplySeconds: request.maxReplySeconds } : {}),
    ...(request.maxNewTokens !== undefined ? { maxNewTokens: request.maxNewTokens } : {}),
    ...(request.greedy !== undefined ? { greedy: request.greedy } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { topP: request.topP } : {}),
    ...(request.topK !== undefined ? { topK: request.topK } : {})
  }
}
