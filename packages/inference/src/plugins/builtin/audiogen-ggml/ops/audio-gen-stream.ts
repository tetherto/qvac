import type { AudioGenStreamRequest, AudioGenStreamResponse } from '@/schemas/audio-gen'
import type { Logger } from '@/logging/index'
import { resolveAudioGenPcm } from '@/plugins/builtin/audiogen-ggml/ops/audio-gen-input'
import { streamAudioGenRun } from '@/plugins/builtin/audiogen-ggml/ops/audio-gen-run'

export function audioGenStream(
  request: AudioGenStreamRequest
): AsyncGenerator<AudioGenStreamResponse> {
  return streamAudioGenRun({
    type: 'audioGenStream',
    request,
    async start(model, ctx, logger) {
      // Reference/source audio is decoded before the run is admitted so the
      // model slot is never held by a request that fails on input decoding.
      const { referenceAudio, sourceAudio } = await resolveAudioInputs(request, logger)
      if (ctx.signal.aborted) return undefined
      return model.run(request.caption, {
        ...(request.lyrics !== undefined && { lyrics: request.lyrics }),
        ...(request.seed !== undefined && { seed: request.seed }),
        ...(request.vocalLanguage !== undefined && { vocalLanguage: request.vocalLanguage }),
        ...(request.bpm !== undefined && { bpm: request.bpm }),
        ...(request.keyscale !== undefined && { keyscale: request.keyscale }),
        ...(request.timesignature !== undefined && { timesignature: request.timesignature }),
        ...(request.augmentCaptionWithMetadata !== undefined && {
          augmentCaptionWithMetadata: request.augmentCaptionWithMetadata
        }),
        ...(request.duration !== undefined && { duration: request.duration }),
        ...(request.maxFrames !== undefined && { maxFrames: request.maxFrames }),
        ...(request.inferenceSteps !== undefined && { inferenceSteps: request.inferenceSteps }),
        ...(request.cfgScale !== undefined && { cfgScale: request.cfgScale }),
        ...(request.lmTemperature !== undefined && { lmTemperature: request.lmTemperature }),
        ...(request.lmTopP !== undefined && { lmTopP: request.lmTopP }),
        ...(request.lmTopK !== undefined && { lmTopK: request.lmTopK }),
        ...(request.lmCfgScale !== undefined && { lmCfgScale: request.lmCfgScale }),
        ...(request.lmPhase1 !== undefined && { lmPhase1: request.lmPhase1 }),
        ...(request.dcwEnabled !== undefined && { dcwEnabled: request.dcwEnabled }),
        ...(request.dcwScaler !== undefined && { dcwScaler: request.dcwScaler }),
        ...(request.dcwHighScaler !== undefined && { dcwHighScaler: request.dcwHighScaler }),
        ...(request.audioCodes !== undefined && {
          audioCodes: Int32Array.from(request.audioCodes)
        }),
        ...(request.taskType !== undefined && { taskType: request.taskType }),
        ...(request.audioCoverStrength !== undefined && {
          audioCoverStrength: request.audioCoverStrength
        }),
        ...(request.coverNoiseStrength !== undefined && {
          coverNoiseStrength: request.coverNoiseStrength
        }),
        ...(referenceAudio && { referenceAudio }),
        ...(sourceAudio && { sourceAudio })
      })
    }
  })
}

/**
 * Decode both optional audio inputs concurrently. When both fail, the first
 * failure is thrown and the second is logged so neither diagnostic is lost.
 */
async function resolveAudioInputs(request: AudioGenStreamRequest, logger: Logger) {
  const [reference, source] = await Promise.allSettled([
    request.referenceAudio
      ? resolveAudioGenPcm(request.referenceAudio, 'referenceAudio')
      : Promise.resolve(undefined),
    request.sourceAudio
      ? resolveAudioGenPcm(request.sourceAudio, 'sourceAudio')
      : Promise.resolve(undefined)
  ])
  const failures = [reference, source].filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )
  if (failures.length > 0) {
    for (const extra of failures.slice(1)) {
      logger.warn(
        `[audiogen] additional audio input failure for modelId=${request.modelId}: ${
          extra.reason instanceof Error ? extra.reason.message : String(extra.reason)
        }`
      )
    }
    throw failures[0]!.reason
  }
  return {
    referenceAudio: reference.status === 'fulfilled' ? reference.value : undefined,
    sourceAudio: source.status === 'fulfilled' ? source.value : undefined
  }
}
