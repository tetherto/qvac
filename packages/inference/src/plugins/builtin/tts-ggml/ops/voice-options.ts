import type { TextToSpeechStreamRequest, TtsRequest, TtsCosyvoice3Instruct } from '@/schemas/index'
import type { DownloadRequestBinding } from '@/handlers/load-model/types'
import { PluginRequestValidationFailedError } from '@/errors/index'
import { resolveModelPath } from '@/handlers/load-model/resolve'
import { getTtsEngineType } from '@/plugins/builtin/tts-ggml/ops/parler-options'

/**
 * Per-request voice controls, spelled as @qvac/tts-ggml takes them on `run()`,
 * `runStream()` and `runStreaming()`: CosyVoice3's `instruct` and Audio8's
 * per-call reference recording (a resolved local path) with its transcript.
 */
export type VoiceJobOptions = {
  instruct?: string | { dialect?: string; volume?: string; style?: string }
  referenceAudio?: string
  referenceText?: string
}

type VoiceOptionsRequest = Pick<
  TtsRequest | TextToSpeechStreamRequest,
  'instruct' | 'referenceAudioSrc' | 'referenceText'
>

// Rebuild the structured instruct without explicit-undefined keys so it
// satisfies the addon's exactOptionalPropertyTypes typing.
export function toAddonInstruct(instruct: TtsCosyvoice3Instruct) {
  if (typeof instruct === 'string') return instruct
  return {
    ...(instruct.dialect !== undefined ? { dialect: instruct.dialect } : {}),
    ...(instruct.volume !== undefined ? { volume: instruct.volume } : {}),
    ...(instruct.style !== undefined ? { style: instruct.style } : {})
  }
}

/**
 * Rejects per-request voice controls the loaded engine does not take. The
 * request schema only knows an opaque modelId, so the engine check lives here:
 * the addon would reject the same fields with its own throw, and naming the SDK
 * field and the engine that takes it is clearer than surfacing that.
 *
 * Synchronous on purpose: both ops call it before they open their request
 * context, so a request that can never run fails without queueing for the
 * model.
 */
export function assertVoiceJobOptionsSupported(
  model: unknown,
  request: VoiceOptionsRequest,
  handlerName: 'textToSpeech' | 'textToSpeechStream'
): void {
  const engine = getTtsEngineType(model)

  if (request.instruct !== undefined && engine !== 'cosyvoice3') {
    throw new PluginRequestValidationFailedError(
      handlerName,
      `instruct is only supported by CosyVoice3 models (engine is ${engine ?? 'unknown'})`
    )
  }

  const referenceKeys = (['referenceAudioSrc', 'referenceText'] as const).filter(
    (key) => request[key] !== undefined
  )
  if (referenceKeys.length > 0 && engine !== 'audio8') {
    throw new PluginRequestValidationFailedError(
      handlerName,
      `${referenceKeys.join(', ')} ${referenceKeys.length === 1 ? 'is' : 'are'} only supported per request by Audio8 models (engine is ${engine ?? 'unknown'})`
    )
  }
}

/**
 * The per-request voice controls in the addon's spelling, or `null` when the
 * request was cancelled while its reference recording was being resolved,
 * whether that resolution then failed or succeeded.
 *
 * `referenceAudioSrc` goes through the same source resolution as the load-time
 * `referenceAudioSrc` (a local path, or a registry / remote source cached on
 * first use), so a request can name a voice the same way a load config does.
 * An uncached remote source downloads here, which can take as long as the
 * synthesis itself. The op therefore resolves it inside its request context
 * and hands that context over as `binding`: the request is already in the
 * registry, so `cancel({ modelId })` finds it, and the download is subscribed
 * to its abort signal, so that cancel and `cancel({ requestId })` both stop
 * the transfer instead of letting speech generation follow it.
 */
export async function resolveVoiceJobOptions(
  request: VoiceOptionsRequest,
  binding: DownloadRequestBinding
): Promise<VoiceJobOptions | null> {
  let referenceAudio: string | undefined
  if (request.referenceAudioSrc !== undefined) {
    try {
      referenceAudio = await resolveModelPath(
        request.referenceAudioSrc,
        undefined,
        undefined,
        binding.signal,
        { requestBinding: binding }
      )
    } catch (error) {
      if (binding.signal.aborted) return null
      throw error
    }
    // A resolution that succeeds does not mean the request is still wanted: a
    // local or cached source only awaits a file check, which no signal
    // interrupts. A cancel that lands during that wait has already fired the
    // op's once-only `model.cancel()`, before any job existed, so starting the
    // engine now would run a cancelled request to completion.
    if (binding.signal.aborted) return null
  }

  return {
    ...(request.instruct !== undefined ? { instruct: toAddonInstruct(request.instruct) } : {}),
    ...(referenceAudio !== undefined ? { referenceAudio } : {}),
    ...(request.referenceText !== undefined ? { referenceText: request.referenceText } : {})
  }
}
