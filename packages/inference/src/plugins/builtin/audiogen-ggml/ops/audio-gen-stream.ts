import type { AudioGenStreamRequest, AudioGenStreamResponse } from '@/schemas/audio-gen'
import { resolveAudioGenInputs } from '@/plugins/builtin/audiogen-ggml/ops/audio-gen-input'
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
      const { referenceAudio, sourceAudio } = await resolveAudioGenInputs(request, {
        modelId: request.modelId,
        logger
      })
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
        ...(request.simpleMode !== undefined && { simpleMode: request.simpleMode }),
        ...(request.rewriteQuery !== undefined && { rewriteQuery: request.rewriteQuery }),
        ...(request.generateLrc !== undefined && { generateLrc: request.generateLrc }),
        ...(request.computeQualityScore !== undefined && {
          computeQualityScore: request.computeQualityScore
        }),
        ...(request.normalizeLoudness !== undefined && {
          normalizeLoudness: request.normalizeLoudness
        }),
        ...(request.guidanceScale !== undefined && { guidanceScale: request.guidanceScale }),
        ...(request.track !== undefined && { track: request.track }),
        ...(request.duration !== undefined && { duration: request.duration }),
        ...(request.maxFrames !== undefined && { maxFrames: request.maxFrames }),
        ...(request.inferenceSteps !== undefined && { inferenceSteps: request.inferenceSteps }),
        ...(request.shift !== undefined && { shift: request.shift }),
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
